/**
 * Event-Pipeline über den echten Transport: time:sync, Validierung für JEDES Event (Invariante 5),
 * übergroße Payloads, unbekannte Events, Event-Limits und die Eskalation Verstöße → Trennung → Gast-Sperre.
 */
import { randomUUID } from "node:crypto";
import {
  type AckResponse,
  CLIENT_EVENT_NAMES,
  type ClientEventAckData,
  type ClientEventName,
  type ClientEventPayloadInput,
} from "@quizmaster/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { timeSyncModule } from "../../src/registry/time-sync.ts";
import type { RealtimeModule } from "../../src/registry/types.ts";
import { VIOLATION_BAN_REASON } from "../../src/registry/violations.ts";
import {
  emitRaw,
  emitRawWithAck,
  eventually,
  metricValue,
  startTestServer,
  type TestClient,
  type TestServer,
  waitForDisconnect,
} from "../helpers/index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const CLOCK_OFFSET_MS = 30_000;

function expectError(response: AckResponse<unknown> | unknown, code: string) {
  expect(response).toMatchObject({ ok: false, error: { code } });
}

describe("Kern-Events", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({ seed: false, clock: { now: () => Date.now() + CLOCK_OFFSET_MS } });
  });
  afterAll(() => server?.cleanup());

  it("time:sync liefert die Serverzeit (nicht die Client-Zeit)", async () => {
    const client = await server.connectClient();
    const before = Date.now();
    const ack = await client.emit("time:sync", { t0: 5 });
    const after = Date.now();
    expect(ack.ok).toBe(true);
    if (ack.ok) {
      expect(ack.data.serverNow).toBeGreaterThanOrEqual(before + CLOCK_OFFSET_MS);
      expect(ack.data.serverNow).toBeLessThanOrEqual(after + CLOCK_OFFSET_MS);
    }
    expect(client.contractViolations).toEqual([]);
    client.close();
  });

  it("time:sync: 10 je 10 s und Socket, dann RATE_LIMITED mit retryAfterMs", async () => {
    const client = await server.connectClient();
    for (let i = 0; i < 10; i++) expect((await client.emit("time:sync", { t0: i })).ok).toBe(true);
    const limited = await client.emit("time:sync", { t0: 10 });
    expectError(limited, "RATE_LIMITED");
    if (!limited.ok) {
      expect(limited.error.retryAfterMs).toBeGreaterThan(0);
      expect(limited.error.retryAfterMs).toBeLessThanOrEqual(10_000);
    }
    // Ein anderer Socket hat ein eigenes Kontingent.
    const other = await server.connectClient();
    expect((await other.emit("time:sync", { t0: 1 })).ok).toBe(true);
    client.close();
    other.close();
  });

  it("ungültige Payloads (Zusatzfelder, falsche Typen, fehlend, zu viele Argumente) → VALIDATION_FAILED", async () => {
    const client = await server.connectClient();
    expectError(await emitRawWithAck(client.socket, "time:sync", [{ t0: 1, extra: true }]), "VALIDATION_FAILED");
    expectError(await emitRawWithAck(client.socket, "time:sync", [{ t0: "1" }]), "VALIDATION_FAILED");
    expectError(await emitRawWithAck(client.socket, "time:sync", [{ t0: -1 }]), "VALIDATION_FAILED");
    expectError(await emitRawWithAck(client.socket, "time:sync", []), "VALIDATION_FAILED");
    expectError(await emitRawWithAck(client.socket, "time:sync", [{ t0: 1 }, "mehr"]), "VALIDATION_FAILED");
    expect(client.socket.connected).toBe(true);
    client.close();
  });

  it("Payload über 8 KB: Transport trennt den Socket, der Server bleibt stabil", async () => {
    const victim = await server.connectClient();
    const bystander = await server.connectClient();
    const disconnected = waitForDisconnect(victim.socket);
    emitRaw(victim.socket, "time:sync", { t0: 1, pad: "x".repeat(10_000) }, () => undefined);
    expect(["transport close", "transport error"]).toContain(await disconnected);
    expect((await bystander.emit("time:sync", { t0: 1 })).ok).toBe(true);
    const health = await server.request("/healthz");
    expect(health.status).toBe(200);
    bystander.close();
  });

  it("unbekannte Events → VALIDATION_FAILED + Verstoß; nach 10 Verstößen trennt der Server", async () => {
    const client = await server.connectClient();
    const before = await metricValue(server.app.services.metrics, "qm_violation_disconnects_total");
    for (let i = 0; i < 10; i++) {
      expectError(await emitRawWithAck(client.socket, `hack:${i}`, [{}]), "VALIDATION_FAILED");
    }
    expect(client.socket.connected).toBe(true);
    const disconnected = waitForDisconnect(client.socket);
    expectError(await emitRawWithAck(client.socket, "hack:last", [{}]), "VALIDATION_FAILED");
    expect(await disconnected).toBe("io server disconnect");
    expect(await metricValue(server.app.services.metrics, "qm_violation_disconnects_total")).toBe(before + 1);
  });

  it("dev:add-bot ist ohne DEV_BOTS_ENABLED unbekannt", async () => {
    const client = await server.connectClient();
    expectError(await emitRawWithAck(client.socket, "dev:add-bot", [{}]), "VALIDATION_FAILED");
    client.close();
  });

  it("wiederholte Verstoß-Trennungen → Gast 15 min gesperrt, alle Sockets bekommen kicked { abuse }", async () => {
    const guestId = randomUUID();
    const bystander = await server.connectClient({ guestId });
    const kicked = bystander.waitFor("kicked", undefined, 20_000);
    const bystanderGone = waitForDisconnect(bystander.socket, 20_000);
    for (let round = 1; round <= 4; round++) {
      const offender = await server.connectClient({ guestId });
      const gone = waitForDisconnect(offender.socket);
      for (let i = 0; i < 11; i++) await emitRawWithAck(offender.socket, "hack", [{}]);
      expect(await gone).toBe("io server disconnect");
      if (round < 4) {
        expect(await server.db.repos.bans.findActive("guest", guestId, new Date())).toBeNull();
      }
    }
    expect(await kicked).toEqual({ reason: "abuse" });
    expect(await bystanderGone).toBe("io server disconnect");
    const ban = await server.db.repos.bans.findActive("guest", guestId, new Date());
    expect(ban?.reason).toBe(VIOLATION_BAN_REASON);
    const remainingMs = (ban?.expiresAt?.getTime() ?? 0) - Date.now();
    expect(remainingMs).toBeGreaterThan(14 * 60_000);
    expect(remainingMs).toBeLessThanOrEqual(15 * 60_000 + CLOCK_OFFSET_MS + 5_000);
    const rejected = await server.tryConnect({ guestId });
    expect(rejected.ok ? null : rejected.failure.code).toBe("BANNED");
    expect(bystander.contractViolations).toEqual([]);
    expect(await server.db.collections.rateLimits.countDocuments({})).toBeGreaterThan(0);
  });
});

/** Gültige Payloads und Ack-Daten je Event (Handler-Attrappen für die Validierungs-Sweeps). */
const VALID_PAYLOADS: { [E in ClientEventName]: ClientEventPayloadInput<E> } = {
  "time:sync": { t0: 1 },
  "lobby:create": { name: "Mia" },
  "lobby:join": { code: "abc 234", name: "Mia" },
  "lobby:resume": { code: "ABC234" },
  "lobby:leave": {},
  "lobby:update-settings": { rounds: 3 },
  "lobby:kick": { playerId: "p1" },
  "lobby:start": {},
  "game:pick": { categoryId: "comics" },
  "game:answer": { questionId: "q1", choice: 1 },
  "game:review": {},
  "game:rematch": {},
  "question:rate": { questionId: "q1", value: 1 },
  "question:report": { questionId: "q1", reason: "falsch" },
  "dev:add-bot": {},
};

const SAMPLE_ACK: { [E in ClientEventName]: ClientEventAckData<E> } = {
  "time:sync": { serverNow: 1 },
  "lobby:create": { code: "ABC234" },
  "lobby:join": { code: "ABC234" },
  "lobby:resume": { code: "ABC234" },
  "lobby:leave": null,
  "lobby:update-settings": null,
  "lobby:kick": null,
  "lobby:start": null,
  "game:pick": null,
  "game:answer": { accepted: true },
  "game:review": [],
  "game:rematch": null,
  "question:rate": null,
  "question:report": null,
  "dev:add-bot": null,
};

describe("Invariante 5 – Validierung für jedes registrierte Event", () => {
  let server: TestServer;
  let client: TestClient;
  const calls: ClientEventName[] = [];

  const everything: RealtimeModule = {
    name: "alle-events-attrappe",
    setup({ registerEvent }) {
      for (const event of CLIENT_EVENT_NAMES) {
        if (event === "time:sync") continue;
        registerEvent(event, () => {
          calls.push(event);
          return SAMPLE_ACK[event];
        });
      }
    },
  };

  beforeAll(async () => {
    // relaxed: viele absichtliche Verstöße hintereinander, ohne dass der Socket getrennt wird.
    server = await startTestServer({
      seed: false,
      devBots: true,
      rateLimits: "relaxed",
      modules: [timeSyncModule, everything],
    });
    client = await server.connectClient();
  });
  afterAll(() => server?.cleanup());

  it("jedes Event ist registriert und nimmt gültige Payloads an", async () => {
    expect(new Set(server.app.registry.registeredEvents())).toEqual(new Set(CLIENT_EVENT_NAMES));
    for (const event of CLIENT_EVENT_NAMES) {
      const ack = await emitRawWithAck(client.socket, event, [VALID_PAYLOADS[event]]);
      expect(ack, event).toMatchObject({ ok: true });
    }
    expect(new Set(calls)).toEqual(new Set(CLIENT_EVENT_NAMES.filter((event) => event !== "time:sync")));
  });

  it("Zusatzfelder, falsche Typen, riesige Strings und Nicht-Objekte → VALIDATION_FAILED, Handler nie aufgerufen", async () => {
    const callsBefore = calls.length;
    for (const event of CLIENT_EVENT_NAMES) {
      const valid = VALID_PAYLOADS[event] as Record<string, unknown>;
      const variants: unknown[] = [
        { ...valid, unexpected: 1 },
        { ...valid, constructor: "x" },
        // Eigener Schlüssel „__proto__“ (wie ihn JSON.parse erzeugt) – Prototype-Pollution-Versuch.
        Object.assign(JSON.parse('{"__proto__":{"polluted":true}}') as object, valid),
        "kein Objekt",
        42,
        null,
        [valid],
      ];
      for (const key of Object.keys(valid)) {
        variants.push({ ...valid, [key]: { $gt: "" } });
        variants.push({ ...valid, [key]: "x".repeat(7_000) });
      }
      for (const payload of variants) {
        const ack = await emitRawWithAck(client.socket, event, [payload]);
        expect(ack, `${event}: ${JSON.stringify(payload).slice(0, 80)}`).toMatchObject({
          ok: false,
          error: { code: "VALIDATION_FAILED" },
        });
      }
    }
    expect(calls.length).toBe(callsBefore);
    expect(client.socket.connected).toBe(true);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(
      await metricValue(server.app.services.metrics, "qm_validation_failures_total", { event: "lobby:join" }),
    ).toBeGreaterThan(0);
    expect(client.contractViolations).toEqual([]);
  });

  it("der Server bleibt nach dem Sweep stabil", async () => {
    await eventually(async () => (await server.request("/healthz")).status === 200);
    const fresh = await server.connectClient();
    expect((await fresh.emit("lobby:create", { name: "Ben" })).ok).toBe(true);
    fresh.close();
  });
});
