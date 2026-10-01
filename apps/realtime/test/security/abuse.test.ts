/**
 * Missbrauchstests (docs/11 §Sicherheits-Invarianten „Weitere Missbrauchstests“, docs/06 Phase-4-Checkliste):
 * Event-Flut, Code-Brute-Force (Sperre greift, verteilt im Mongo-Store), fremde Origin, abgelaufene und
 * wiederverwendete Tickets, gesperrter Gast (sofortige Trennung via Change Stream), Namen mit Zero-Width-/
 * Bidi-Zeichen, Emojis und Leetspeak-Schimpfwörtern.
 */
import { randomUUID } from "node:crypto";
import { CLIENT_EVENT_NAMES, type ClientEventName } from "@quizmaster/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRateLimitService } from "../../src/services/rate-limit.ts";
import { createLobby, joinLobby } from "../game/support.ts";
import {
  emitRawWithAck,
  metricValue,
  newTicketId,
  type TestClient,
  type TestServer,
  waitForDisconnect,
} from "../helpers/index.ts";
import { startSecurityServer, VALID_PAYLOADS } from "./support.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startSecurityServer();
});
afterAll(() => server?.cleanup());

describe("Event-Flut", () => {
  it("200 Events in einem Schwall → Socket getrennt (Fallback 30/s + Verstöße), andere Clients und Server stabil", async () => {
    const attacker = await server.connectClient();
    const bystander = await server.connectClient();
    const gone = waitForDisconnect(attacker.socket, 10_000);
    const events: ClientEventName[] = CLIENT_EVENT_NAMES.filter((event) => event !== "dev:add-bot");
    const burst = Array.from({ length: 200 }, (_, index) => {
      const event = events[index % events.length] as ClientEventName;
      // Antworten nach der Trennung bleiben aus – der Schwall wartet nicht darauf.
      return emitRawWithAck(attacker.socket, event, [VALID_PAYLOADS[event]], 3_000).then(
        (ack) => ack,
        () => null,
      );
    });
    expect(await gone).toBe("io server disconnect");
    const acks = await Promise.all(burst);
    const limited = acks.filter((ack) => (ack as { error?: { code?: string } } | null)?.error?.code === "RATE_LIMITED");
    expect(limited.length).toBeGreaterThan(0);
    expect((await bystander.emit("time:sync", { t0: 1 })).ok).toBe(true);
    expect((await server.request("/healthz")).status).toBe(200);
    bystander.close();
  });
});

describe("Code-Brute-Force", () => {
  it("mehr als 20 falsche Codes je IP in 5 min → 15 min gesperrt – auch für gültige Codes, über alle Sockets der IP", async () => {
    const host = await server.connectClient();
    const code = await createLobby(host, "Mia");
    const ip = server.nextIp();
    const guessers: TestClient[] = [];
    let failures = 0;
    // 20 Fehlversuche sind frei, der 21. löst die Sperre aus (Socket-Limit 10/min → mehrere Sockets der IP).
    for (let socket = 0; socket < 3 && failures < 21; socket++) {
      const guesser = await server.connectClient({ ip });
      guessers.push(guesser);
      for (let i = 0; i < 7 && failures < 21; i++) {
        const guess = `ZZZZ${"ABCDEFGHJKMN"[failures % 12]}${"PQRSTUVWX"[i % 9]}`;
        const wrong = guess === code ? "ZZZZZZ" : guess;
        const result = await guesser.emit("lobby:join", { code: wrong, name: "Rater" });
        expect(result).toMatchObject({ ok: false, error: { code: "LOBBY_NOT_FOUND" } });
        failures += 1;
      }
    }
    expect(failures).toBe(21);
    const fresh = await server.connectClient({ ip });
    const blocked = await fresh.emit("lobby:join", { code, name: "Rater" });
    expect(blocked).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    if (!blocked.ok) expect(blocked.error.retryAfterMs ?? 0).toBeGreaterThan(14 * 60_000);
    // Die Sperre liegt im Mongo-Store: ein zweiter Prozess sieht sie ebenso (verteilte Zähler).
    const store = createRateLimitService({
      mode: "normal",
      store: {
        client: server.db.client,
        dbName: server.db.db.databaseName,
        collection: server.db.collections.rateLimits,
      },
    });
    const ipKeyOf = server.app.io.sockets.sockets.get(fresh.socket.id ?? "")?.data.ipKey ?? "";
    expect(ipKeyOf).not.toBe("");
    expect((await store.peek(store.rule("event.lobby-join.failed.ip"), ipKeyOf)).allowed).toBe(false);
    // Andere IPs treten normal bei.
    const honest = await server.connectClient();
    await joinLobby(honest, code, "Ben");
    for (const client of [host, ...guessers, fresh, honest]) client.close();
  });

  it("Raten über lobby:resume hat eine eigene Sperre (gleiche Grenzen)", async () => {
    const ip = server.nextIp();
    let failures = 0;
    const guessers: TestClient[] = [];
    while (failures < 21) {
      const guesser = await server.connectClient({ ip });
      guessers.push(guesser);
      for (let i = 0; i < 7 && failures < 21; i++) {
        const result = await guesser.emit("lobby:resume", { code: `YYYY${"ABCDEFGHJK"[failures % 10]}${i + 2}` });
        expect(result).toMatchObject({ ok: false, error: { code: "LOBBY_NOT_FOUND" } });
        failures += 1;
      }
    }
    const last = await server.connectClient({ ip });
    expect(await last.emit("lobby:resume", { code: "YYYYZZ" })).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED" },
    });
    for (const client of [...guessers, last]) client.close();
  });
});

describe("Handshake: Origin und Tickets", () => {
  it("fremde Origin (WebSocket und Polling), fehlende Origin ohne Sec-Fetch-Site → abgelehnt ohne Code", async () => {
    const before = await metricValue(server.app.services.metrics, "qm_connections_rejected_total", {
      reason: "origin",
    });
    for (const transports of [["websocket"], ["polling"]] as const) {
      const foreign = await server.tryConnect({ origin: "https://evil.example", transports: [...transports] });
      expect(foreign.ok).toBe(false);
      if (!foreign.ok) expect(foreign.failure.code).toBeNull();
    }
    const missing = await server.tryConnect({ origin: null, transports: ["polling"] });
    expect(missing.ok).toBe(false);
    const lookalike = await server.tryConnect({ origin: `${server.origin}.evil.example` });
    expect(lookalike.ok).toBe(false);
    expect(
      await metricValue(server.app.services.metrics, "qm_connections_rejected_total", { reason: "origin" }),
    ).toBeGreaterThanOrEqual(before + 4);
    // ADR-028: ohne Origin nur mit Sec-Fetch-Site: same-origin (Ticket bleibt Pflicht).
    const sameOrigin = await server.tryConnect({
      origin: null,
      transports: ["polling"],
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(sameOrigin.ok).toBe(true);
    if (sameOrigin.ok) sameOrigin.client.close();
  });

  it("abgelaufenes, wiederverwendetes, fremd signiertes, unsigniertes und zu langes Ticket → UNAUTHORIZED", async () => {
    const guestId = randomUUID();
    const cases: Array<{ label: string; ticket: string }> = [
      { label: "abgelaufen", ticket: await server.mintTicket(guestId, { expiresInSec: -30 }) },
      { label: "fremdes Secret", ticket: await server.mintTicket(guestId, { secret: "x".repeat(40) }) },
      { label: "alg none", ticket: await server.mintTicket(guestId, { algorithm: "none" }) },
      { label: "HS512", ticket: await server.mintTicket(guestId, { algorithm: "HS512" }) },
      { label: "falsche Audience", ticket: await server.mintTicket(guestId, { audience: "web" }) },
      { label: "falscher Issuer", ticket: await server.mintTicket(guestId, { issuer: "evil" }) },
      { label: "ohne jti", ticket: await server.mintTicket(guestId, { omit: ["jti"] }) },
      { label: "exp weit in der Zukunft", ticket: await server.mintTicket(guestId, { expiresInSec: 3_600 }) },
      { label: "keine UUID", ticket: await server.mintTicket("admin") },
      { label: "Müll", ticket: "a.b.c" },
    ];
    for (const entry of cases) {
      const result = await server.tryConnect({ guestId, ticket: entry.ticket });
      expect(result.ok, entry.label).toBe(false);
      if (!result.ok) expect(result.failure.code, entry.label).toBe("UNAUTHORIZED");
    }
    // Wiederverwendung: dasselbe Ticket (gleiche jti) nur einmal – auch nach dem Trennen.
    const ticket = await server.mintTicket(guestId, { jti: newTicketId() });
    const first = await server.tryConnect({ guestId, ticket });
    expect(first.ok).toBe(true);
    if (first.ok) first.client.close();
    const replay = await server.tryConnect({ guestId, ticket });
    expect(replay.ok ? null : replay.failure.code).toBe("UNAUTHORIZED");
  });
});

describe("Gesperrter Gast", () => {
  it("Sperre per Change Stream → sofort getrennt; Neuverbindung → BANNED", async () => {
    const guestId = randomUUID();
    const client = await server.connectClient({ guestId });
    const kicked = client.waitFor("kicked", undefined, 10_000);
    const gone = waitForDisconnect(client.socket, 10_000);
    await server.db.repos.bans.upsert(
      { kind: "guest", value: guestId, reason: "Missbrauch", expiresAt: new Date(Date.now() + 60 * 60_000) },
      new Date(),
    );
    expect(await kicked).toEqual({ reason: "abuse" });
    expect(await gone).toBe("io server disconnect");
    const retry = await server.tryConnect({ guestId });
    expect(retry.ok ? null : retry.failure.code).toBe("BANNED");
  });
});

describe("Namen (docs/06 §Eingaben)", () => {
  const REJECTED: ReadonlyArray<[string, string]> = [
    ["Zero-Width Space", "Mia​"],
    ["Zero-Width Joiner", "Mi‍a"],
    ["Zero-Width Non-Joiner", "Mi‌a"],
    ["Word Joiner", "Mia⁠"],
    ["BOM in der Mitte", "Mi﻿a"],
    ["Right-to-Left Override", "Mi‮a"],
    ["Bidi-Isolate", "⁦Mia⁩"],
    ["Right-to-Left Mark", "Mia‏"],
    ["Arabic Letter Mark", "Mia؜"],
    ["Emoji", "Mia \u{1F600}"],
    ["nur Emojis", "\u{1F525}\u{1F525}"],
    ["Leetspeak englisch", "F1ck"],
    ["Leetspeak deutsch", "4rschl0ch"],
    ["Leetspeak mit Zahlen", "Hur3ns0hn"],
    ["mit Leerzeichen gesperrt", "A r s c h"],
    ["mit Punkten", "f.u.c.k"],
    ["Umlaut-Variante", "Fuehrer"],
    ["NS-Zahlencode", "88"],
    ["reserviert", "Adm1n"],
    ["reserviert (Quizmaster)", "Quizmaster"],
    ["zu kurz", "M"],
    ["zu lang", "Abcdefghijklmnopq"],
  ];

  it("lobby:create und lobby:join lehnen Zero-Width/Bidi, Emojis, Leetspeak und Reserviertes ab (NAME_REJECTED)", async () => {
    const host = await server.connectClient();
    const code = await createLobby(host, "Mia");
    for (const [label, name] of REJECTED) {
      // Je Name ein frischer Gast mit eigener IP: abgelehnte Beitritte zählen als Fehlversuch (Raten-Limit).
      const client = await server.connectClient();
      const created = await client.emit("lobby:create", { name });
      expect(created, `create: ${label}`).toMatchObject({ ok: false, error: { code: "NAME_REJECTED" } });
      const joined = await client.emit("lobby:join", { code, name });
      expect(joined, `join: ${label}`).toMatchObject({ ok: false, error: { code: "NAME_REJECTED" } });
      // Die Meldung nennt nur die Art der Ablehnung, nie den Namen (keine Spiegelung von Eingaben).
      for (const ack of [created, joined]) {
        if (!ack.ok) expect(ack.error.message.includes(name), label).toBe(false);
      }
      client.close();
    }
    host.close();
  });

  it("gültige Namen bleiben erlaubt; führende/folgende Leerzeichen und BOM werden entfernt, Dubletten nummeriert", async () => {
    const host = await server.connectClient();
    const code = await createLobby(host, "  Jürgen  ");
    const names: string[] = [];
    for (const name of ["Zoë", "Ben-2", "Ana_Lena", "﻿Jürgen"]) {
      const guest = await server.connectClient();
      const state = guest.waitFor("lobby:state", (payload) => payload.players.length >= 2);
      await joinLobby(guest, code, name);
      names.push(...(await state).players.map((player) => player.name));
      guest.close();
    }
    expect(names).toEqual(expect.arrayContaining(["Jürgen", "Zoë", "Ben-2", "Ana_Lena", "Jürgen 2"]));
    host.close();
  });
});
