/**
 * Watcher und Kill-Switches (docs/04 §Change-Stream-Watcher, docs/06 §DDoS-Schicht 6, Phase-4-Checkliste
 * „Kill-Switches getestet (Change Stream schaltet live um)“): Änderungen gehen wie im Betrieb über die Datenbank
 * (Repository bzw. Admin-CLI-Weg) und wirken ohne Neustart – Sperren trennen sofort (`kicked { abuse }`), die
 * Schalter in appConfig greifen beim nächsten Event bzw. Handshake.
 */
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION } from "@quizmaster/shared";
import { APP_CONFIG_ID } from "@quizmaster/shared/documents";
import { ipKey } from "@quizmaster/shared/ip";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { timeSyncModule } from "../../src/registry/time-sync.ts";
import { sweepConnectedSockets } from "../../src/services/bans.ts";
import { createLobby, joinLobby, runtimeOf } from "../game/support.ts";
import { emitWithAck, eventually, metricValue, type TestServer, waitForDisconnect } from "../helpers/index.ts";
import { connectEarly, startSecurityServer } from "./support.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startSecurityServer();
});
afterAll(() => server?.cleanup());

/** Setzt appConfig wie die Admin-CLI (Repository-Update in der DB) und wartet, bis Realtime es übernommen hat. */
async function setConfig(patch: Parameters<TestServer["db"]["repos"]["appConfig"]["update"]>[0]): Promise<void> {
  const updated = await server.db.repos.appConfig.update(patch, new Date());
  await eventually(() => server.app.services.appConfig.get().updatedAt.getTime() === updated.updatedAt.getTime());
}

const DEFAULTS = {
  maintenance: { enabled: false, message: null },
  lobbyCreationEnabled: true,
  turnstileOnJoin: false,
  maxActiveLobbies: 5_000,
  minClientProtocol: 1,
  blockedTerms: [] as string[],
};

describe("bans-Watcher: Sperre → sofortige Trennung", () => {
  it("Gast-Sperre über die DB: alle Sockets des Gasts bekommen kicked { abuse } und werden getrennt", async () => {
    const guestId = randomUUID();
    const tabA = await server.connectClient({ guestId });
    const tabB = await server.connectClient({ guestId });
    const bystander = await server.connectClient();
    const kickedA = tabA.waitFor("kicked", undefined, 10_000);
    const goneA = waitForDisconnect(tabA.socket, 10_000);
    const goneB = waitForDisconnect(tabB.socket, 10_000);
    const startedAt = Date.now();
    await server.db.repos.bans.upsert(
      { kind: "guest", value: guestId, reason: "Admin-Test", expiresAt: new Date(Date.now() + 3_600_000) },
      new Date(),
    );
    expect(await kickedA).toEqual({ reason: "abuse" });
    expect(await goneA).toBe("io server disconnect");
    expect(await goneB).toBe("io server disconnect");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(bystander.socket.connected).toBe(true);
    const again = await server.tryConnect({ guestId });
    expect(again.ok ? null : again.failure.code).toBe("BANNED");
    bystander.close();
  });

  it("IP-Sperre trennt alle Gäste dieser IP; andere IPs bleiben verbunden", async () => {
    const ip = server.nextIp();
    const first = await server.connectClient({ ip });
    const second = await server.connectClient({ ip });
    const other = await server.connectClient();
    const gone = Promise.all([waitForDisconnect(first.socket, 10_000), waitForDisconnect(second.socket, 10_000)]);
    const key = ipKey(ip, server.secrets.ipHash);
    if (key === null) throw new Error("IP-Schlüssel fehlt");
    await server.db.repos.bans.upsert({ kind: "ip", value: key, reason: "Flut" }, new Date());
    expect(await gone).toEqual(["io server disconnect", "io server disconnect"]);
    expect(other.socket.connected).toBe(true);
    const rejected = await server.tryConnect({ ip });
    expect(rejected.ok ? null : rejected.failure.code).toBe("BANNED");
    other.close();
  });

  it("abgelaufene Sperre trennt niemanden; Aufheben (delete) ebenso nicht", async () => {
    const guestId = randomUUID();
    const client = await server.connectClient({ guestId });
    await server.db.repos.bans.upsert(
      { kind: "guest", value: guestId, reason: "alt", expiresAt: new Date(Date.now() - 60_000) },
      new Date(Date.now() - 120_000),
    );
    await server.db.repos.bans.remove("guest", guestId);
    // Ein Marker-Bann für einen anderen Gast danach: ist er verarbeitet, war es die alte Änderung sicher auch.
    const marker = await server.connectClient();
    const markerGone = waitForDisconnect(marker.socket, 10_000);
    await server.db.repos.bans.upsert({ kind: "guest", value: marker.guestId, reason: "Marker" }, new Date());
    await markerGone;
    expect(client.socket.connected).toBe(true);
    client.close();
  });

  it("eine ungültige Sperre (manueller DB-Eingriff) blockiert den Stream nicht – spätere Sperren wirken", async () => {
    await server.db.db
      .collection<{ _id: string }>(server.db.collections.bans.collectionName)
      .insertOne({ _id: randomUUID(), kind: "kaputt", value: "", reason: 42 } as unknown as { _id: string });
    const client = await server.connectClient();
    const gone = waitForDisconnect(client.socket, 10_000);
    await server.db.repos.bans.upsert({ kind: "guest", value: client.guestId, reason: "danach" }, new Date());
    expect(await gone).toBe("io server disconnect");
  });

  it("Verstoß-Sperre aus Realtime selbst trennt ebenso (Watcher + Eskalation, Sperre wird nie verkürzt)", async () => {
    const guestId = randomUUID();
    const victim = await server.connectClient({ guestId });
    const gone = waitForDisconnect(victim.socket, 10_000);
    const ban = await server.app.services.bans.banGuest(guestId, { durationSec: 900, reason: "violations" });
    expect(ban.reason).toBe("violations");
    await gone;
    const longer = await server.db.repos.bans.upsert({ kind: "guest", value: guestId, reason: "admin" }, new Date());
    expect(longer.expiresAt).toBeUndefined();
    const kept = await server.app.services.bans.banGuest(guestId, { durationSec: 900, reason: "violations" });
    expect(kept.expiresAt).toBeUndefined();
    expect(kept.reason).toBe("admin");
  });

  it("Vollabgleich (nach Stream-Reset bzw. Sicherheitsnetz) trennt verbundene, inzwischen gesperrte Gäste", async () => {
    // Server OHNE Sicherheits-Modul: die Sperre ist eine „verpasste“ Änderung, nur der Abgleich findet sie.
    const bare = await startSecurityServer({ seed: false, modules: [timeSyncModule], database: server.database });
    try {
      const banned = await bare.connectClient();
      const bannedIp = bare.nextIp();
      const sameIp = await bare.connectClient({ ip: bannedIp });
      const fine = await bare.connectClient();
      const gone = Promise.all([waitForDisconnect(banned.socket, 10_000), waitForDisconnect(sameIp.socket, 10_000)]);
      const key = ipKey(bannedIp, bare.secrets.ipHash);
      if (key === null) throw new Error("IP-Schlüssel fehlt");
      await bare.db.collections.bans.insertMany([
        { _id: randomUUID(), kind: "guest", value: banned.guestId, reason: "verpasst", createdAt: new Date() },
        { _id: randomUUID(), kind: "ip", value: key, reason: "verpasst", createdAt: new Date() },
        {
          _id: randomUUID(),
          kind: "guest",
          value: fine.guestId,
          reason: "abgelaufen",
          createdAt: new Date(),
          expiresAt: new Date(Date.now() - 1_000),
        },
      ]);
      const { services } = bare.app;
      const sockets = await sweepConnectedSockets({
        repo: bare.db.repos.bans,
        connections: services.connections,
        bans: services.bans,
        clock: { now: () => Date.now() },
      });
      expect(sockets).toBe(2);
      expect(await gone).toEqual(["io server disconnect", "io server disconnect"]);
      expect(fine.socket.connected).toBe(true);
      expect(banned.received.find((entry) => entry.event === "kicked")?.payload).toEqual({ reason: "abuse" });
      fine.close();
    } finally {
      await bare.cleanup();
    }
  });
});

describe("appConfig-Watcher: Kill-Switches schalten live um", () => {
  afterEach(async () => {
    await setConfig(DEFAULTS);
  });

  it("lobbyCreationEnabled=false → LOBBY_CREATION_DISABLED, wieder an → Lobby entsteht", async () => {
    const client = await server.connectClient();
    await setConfig({ lobbyCreationEnabled: false });
    expect(await client.emit("lobby:create", { name: "Mia" })).toMatchObject({
      ok: false,
      error: { code: "LOBBY_CREATION_DISABLED" },
    });
    await setConfig({ lobbyCreationEnabled: true });
    expect((await client.emit("lobby:create", { name: "Mia" })).ok).toBe(true);
    client.close();
  });

  it("maxActiveLobbies erreicht → SERVER_BUSY für neue Lobbys, bestehende laufen weiter", async () => {
    const host = await server.connectClient();
    const code = await createLobby(host, "Mia");
    await setConfig({ maxActiveLobbies: runtimeOf(server).lobbies.size });
    const late = await server.connectClient();
    expect(await late.emit("lobby:create", { name: "Ben" })).toMatchObject({
      ok: false,
      error: { code: "SERVER_BUSY" },
    });
    // Beitreten in eine bestehende Lobby bleibt möglich.
    await joinLobby(late, code, "Ben");
    host.close();
    late.close();
  });

  it("turnstileOnJoin=true → TURNSTILE_REQUIRED ohne frisches tsv, mit tsv erlaubt; resume bleibt frei", async () => {
    const host = await server.connectClient();
    const code = await createLobby(host, "Mia");
    await setConfig({ turnstileOnJoin: true });
    const plain = await server.connectClient();
    expect(await plain.emit("lobby:join", { code, name: "Ben" })).toMatchObject({
      ok: false,
      error: { code: "TURNSTILE_REQUIRED" },
    });
    expect(await plain.emit("lobby:create", { name: "Ben" })).toMatchObject({
      ok: false,
      error: { code: "TURNSTILE_REQUIRED" },
    });
    // Der Client löst Turnstile, holt ein Ticket mit tsv und verbindet neu (gleicher Gast) – dann klappt es.
    const verified = await server.connectClient({ guestId: plain.guestId, ticketOptions: { tsv: Date.now() } });
    expect(await verified.emit("lobby:join", { code, name: "Ben" })).toEqual({ ok: true, data: { code } });
    expect(await host.emit("lobby:resume", { code })).toEqual({ ok: true, data: { code } });
    await setConfig({ turnstileOnJoin: false });
    const after = await server.connectClient();
    expect((await after.emit("lobby:join", { code, name: "Lea" })).ok).toBe(true);
    for (const client of [host, plain, verified, after]) client.close();
  });

  it("Wartung an → notice MAINTENANCE an alle Verbundenen und an jede neue Verbindung; aus → keine Hinweise", async () => {
    const connected = await server.connectClient();
    const notice = connected.waitFor("notice", (payload) => payload.code === "MAINTENANCE", 10_000);
    await setConfig({ maintenance: { enabled: true, message: "Kurze Wartung" } });
    expect(await notice).toEqual({ code: "MAINTENANCE" });
    // Neue Verbindung (Listener vor dem Connect wie im Web-Client): Hinweis direkt nach dem Verbinden.
    const fresh = await connectEarly(server);
    await eventually(() => fresh.received.some((entry) => entry.event === "notice"));
    expect(fresh.received.filter((entry) => entry.event === "notice")).toEqual([
      expect.objectContaining({ payload: { code: "MAINTENANCE" } }),
    ]);
    // Wartung blockiert nichts: Lobbys entstehen weiter (Sperren nur über lobbyCreationEnabled).
    expect((await emitWithAck(fresh.socket, "lobby:create", { name: "Mia" })).ok).toBe(true);
    await setConfig({ maintenance: { enabled: false, message: null } });
    const later = await connectEarly(server);
    expect((await emitWithAck(later.socket, "time:sync", { t0: 1 })).ok).toBe(true);
    expect(later.received.some((entry) => entry.event === "notice")).toBe(false);
    for (const client of [connected, fresh, later]) client.close();
  });

  it("minClientProtocol erhöht → ältere Clients werden getrennt und bekommen beim Neuverbinden UPDATE_REQUIRED", async () => {
    const old = await server.connectClient();
    const current = await server.connectClient({ protocolVersion: PROTOCOL_VERSION + 1 });
    const gone = waitForDisconnect(old.socket, 10_000);
    await setConfig({ minClientProtocol: PROTOCOL_VERSION + 1 });
    expect(await gone).toBe("io server disconnect");
    expect(current.socket.connected).toBe(true);
    const retry = await server.tryConnect();
    expect(retry.ok ? null : retry.failure.code).toBe("UPDATE_REQUIRED");
    current.close();
  });

  it("blockedTerms live: neuer Begriff → NAME_REJECTED beim nächsten Beitritt", async () => {
    const client = await server.connectClient();
    await setConfig({ blockedTerms: ["Zonkel"] });
    expect(await client.emit("lobby:create", { name: "Zonkel" })).toMatchObject({
      ok: false,
      error: { code: "NAME_REJECTED" },
    });
    await setConfig({ blockedTerms: [] });
    expect((await client.emit("lobby:create", { name: "Zonkel" })).ok).toBe(true);
    client.close();
  });

  it("ungültiges appConfig-Dokument wird nicht übernommen (letzter gültiger Stand bleibt), danach wieder live", async () => {
    const metrics = server.app.services.metrics;
    const before = await metricValue(metrics, "qm_change_stream_restarts_total", { stream: "appConfig" });
    await server.db.collections.appConfig.updateOne(
      { _id: APP_CONFIG_ID },
      { $set: { maxActiveLobbies: -5, updatedAt: new Date() } },
    );
    await eventually(
      async () => (await metricValue(metrics, "qm_change_stream_restarts_total", { stream: "appConfig" })) > before,
      15_000,
    );
    expect(server.app.services.appConfig.get().maxActiveLobbies).toBe(5_000);
    await setConfig({ maxActiveLobbies: 1_234 });
    expect(server.app.services.appConfig.get().maxActiveLobbies).toBe(1_234);
  });
});
