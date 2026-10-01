/**
 * Event-Registry und -Pipeline: Invariante 6 (jedes Event hat Handler UND Limit), Ack-Semantik, Validierung,
 * Limits, Verstöße und Eskalation – ohne Netzwerk über Fake-Sockets. Der Produktionsstart mit fehlenden
 * Handlern wird gegen die Test-DB geprüft.
 */
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createRepositories } from "@quizmaster/db";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import {
  type AckResponse,
  CLIENT_EVENT_NAMES,
  CLIENT_EVENTS,
  type ClientEventAckData,
  type ClientEventName,
  ProtocolError,
  RATE_LIMITS,
  rateLimitsFor,
} from "@quizmaster/shared";
import type { BanDoc } from "@quizmaster/shared/documents";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRealtimeApp } from "../../src/app.ts";
import { parseRealtimeEnv } from "../../src/env.ts";
import { createLogger, createSecurityLog, createSilentLogger, type Logger } from "../../src/logger.ts";
import { createMetrics } from "../../src/metrics.ts";
import { REALTIME_MODULES } from "../../src/registry/modules.ts";
import { createEventRegistry, type EventRegistry, isFailedAttempt } from "../../src/registry/registry.ts";
import { timeSyncModule } from "../../src/registry/time-sync.ts";
import { type EventHandler, type ModuleContext, type RealtimeModule, systemClock } from "../../src/registry/types.ts";
import { createViolationTracker } from "../../src/registry/violations.ts";
import type { BansService } from "../../src/services/bans.ts";
import { createRateLimitService, type RateLimitService } from "../../src/services/rate-limit.ts";
import { createFakeSocket, DEFAULT_TEST_PORTS, type FakeSocket, metricValue } from "../helpers/index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

/** Gültige Ack-Daten je Event für Dummy-Handler. */
const SAMPLE_ACK: { [E in ClientEventName]: ClientEventAckData<E> } = {
  "time:sync": { serverNow: 1 },
  "lobby:create": { code: "ABC234" },
  "lobby:join": { code: "ABC234" },
  "lobby:resume": { code: "ABC234" },
  "lobby:leave": null,
  "lobby:update-settings": null,
  "lobby:kick": null,
  "lobby:rename": null,
  "lobby:start": null,
  "game:pick": null,
  "game:answer": { accepted: true },
  "game:review": [],
  "game:rematch": null,
  "game:continue": null,
  "question:rate": null,
  "question:report": null,
  "dev:add-bot": null,
};

function registerAll(register: EventRegistry["register"]): Map<ClientEventName, boolean> {
  const result = new Map<ClientEventName, boolean>();
  for (const event of CLIENT_EVENT_NAMES) {
    result.set(
      event,
      register(event, () => SAMPLE_ACK[event]),
    );
  }
  return result;
}

interface TestRegistryOptions {
  devBots?: boolean;
  handlerTimeoutMs?: number;
  shuttingDown?: () => boolean;
  rateLimit?: RateLimitService;
  logger?: Logger;
}

function createTestRegistry(options: TestRegistryOptions = {}) {
  const logger = options.logger ?? createSilentLogger();
  const metrics = createMetrics({ socketCount: () => 0 });
  const security = createSecurityLog(logger);
  const rateLimit = options.rateLimit ?? createRateLimitService({ mode: "normal" });
  const banned: Array<{ guestId: string; durationSec: number; reason: string }> = [];
  const bans: BansService = {
    findActive: async () => null,
    async banGuest(guestId, ban) {
      banned.push({ guestId, ...ban });
      const doc: BanDoc = {
        _id: randomUUID(),
        kind: "guest",
        value: guestId,
        reason: ban.reason,
        createdAt: new Date(),
      };
      return doc;
    },
    disconnectBanned: () => 0,
  };
  const violations = createViolationTracker({ rateLimit, bans, metrics, security, logger });
  const registry = createEventRegistry({
    devBotsEnabled: options.devBots ?? true,
    clock: systemClock,
    logger,
    metrics,
    security,
    rateLimit,
    violations,
    lifecycle: { isShuttingDown: options.shuttingDown ?? (() => false) },
    ...(options.handlerTimeoutMs === undefined ? {} : { handlerTimeoutMs: options.handlerTimeoutMs }),
  });
  const attach = (fake: FakeSocket = createFakeSocket()) => {
    registry.attach(fake.socket);
    return fake;
  };
  return { registry, metrics, rateLimit, banned, attach };
}

function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { logger: createLogger({ level: "debug", destination }), lines };
}

function expectError(response: AckResponse<unknown>, code: string) {
  expect(response.ok).toBe(false);
  if (!response.ok) expect(response.error.code).toBe(code);
}

describe("Invariante 6 – jedes Event hat Handler und Limit", () => {
  it("jedes Event aus CLIENT_EVENTS hat mindestens ein Zeitfenster-Limit (auch relaxed)", () => {
    for (const mode of ["normal", "relaxed"] as const) {
      const rateLimit = createRateLimitService({ mode });
      for (const event of CLIENT_EVENT_NAMES) {
        const rules = rateLimit.rulesFor(event).filter((rule) => rule.kind === "rate");
        expect(rules.length, `${event} (${mode})`).toBeGreaterThan(0);
      }
    }
  });

  it("die Registry nimmt jedes Event aus CLIENT_EVENTS mit Handler und Limit auf", () => {
    const { registry } = createTestRegistry({ devBots: true });
    const registered = registerAll(registry.register);
    expect([...registered.values()].every(Boolean)).toBe(true);
    expect(new Set(registry.registeredEvents())).toEqual(new Set(CLIENT_EVENT_NAMES));
    expect(registry.missingHandlers()).toEqual([]);
    for (const event of registry.registeredEvents()) {
      expect(registry.has(event)).toBe(true);
      expect(registry.limitsOf(event).length, event).toBeGreaterThan(0);
      expect(registry.limitsOf(event).every((rule) => rule.kind === "rate")).toBe(true);
    }
  });

  it("ohne DEV_BOTS_ENABLED wird dev:add-bot nicht registriert und nicht als fehlend gemeldet", () => {
    const { registry } = createTestRegistry({ devBots: false });
    const registered = registerAll(registry.register);
    expect(registered.get("dev:add-bot")).toBe(false);
    expect(registry.has("dev:add-bot")).toBe(false);
    expect(registry.missingHandlers()).toEqual([]);
    expect(CLIENT_EVENTS["dev:add-bot"].devOnly).toBe(true);
  });

  it("verweigert Events ohne Limit, doppelte und unbekannte Registrierungen", () => {
    const base = createRateLimitService({ mode: "normal" });
    const withoutLimits: RateLimitService = { ...base, rulesFor: () => [] };
    const { registry: strict } = createTestRegistry({ rateLimit: withoutLimits });
    expect(() => strict.register("time:sync", () => SAMPLE_ACK["time:sync"])).toThrow(/kein Rate-Limit/);

    const { registry } = createTestRegistry();
    registry.register("time:sync", () => SAMPLE_ACK["time:sync"]);
    expect(() => registry.register("time:sync", () => SAMPLE_ACK["time:sync"])).toThrow(/bereits registriert/);
    expect(() => registry.register("lobby:explode" as ClientEventName, () => null)).toThrow(/Unbekanntes Event/);
  });

  it("die Produktions-Module registrieren nur Events mit Limit; fehlende meldet missingHandlers()", async () => {
    const { registry } = createTestRegistry({ devBots: true });
    const context = {
      registerEvent: registry.register,
      onConnection: () => undefined,
      onDisconnect: () => undefined,
      onStart: () => undefined,
      onShutdown: () => undefined,
      clock: systemClock,
    } as unknown as ModuleContext;
    for (const module of REALTIME_MODULES) await module.setup(context);
    const registered = registry.registeredEvents();
    expect(registered).toContain("time:sync");
    for (const event of registered) {
      expect(CLIENT_EVENT_NAMES).toContain(event);
      expect(registry.limitsOf(event).length).toBeGreaterThan(0);
    }
    expect(new Set([...registered, ...registry.missingHandlers()])).toEqual(new Set(CLIENT_EVENT_NAMES));
  });

  it("Tabelle RATE_LIMITS: Event-Regeln verweisen nur auf bekannte Events", () => {
    const eventTargets = RATE_LIMITS.filter((rule) => rule.target.includes(":") && !rule.target.startsWith("socket:"));
    for (const rule of eventTargets) {
      if (rule.target === "guest:violation-disconnect") continue;
      expect(CLIENT_EVENT_NAMES as readonly string[]).toContain(rule.target);
    }
    expect(rateLimitsFor("socket:any-event").length).toBe(1);
  });
});

describe("Event-Pipeline", () => {
  it("antwortet genau einmal mit den Ack-Daten des Handlers", async () => {
    const { registry, attach, metrics } = createTestRegistry();
    registry.register("time:sync", () => ({ serverNow: 42 }));
    const fake = attach();
    const response = await fake.call("time:sync", { t0: 1 });
    expect(response).toEqual({ ok: true, data: { serverNow: 42 } });
    expect(await metricValue(metrics, "qm_socket_events_total", { event: "time:sync", outcome: "ok" })).toBe(1);
  });

  it("übergibt den validierten Payload und einen vollständigen Kontext", async () => {
    const { registry, attach } = createTestRegistry();
    const seen: unknown[] = [];
    registry.register("lobby:join", (payload, ctx) => {
      seen.push(payload, ctx.guestId, ctx.ipKey, ctx.event, typeof ctx.requestId, typeof ctx.now);
      return { code: payload.code };
    });
    const fake = attach(createFakeSocket({ ipKey: "ip-a" }));
    const response = await fake.call("lobby:join", { code: "abc-234", name: "Mia" });
    expect(response).toEqual({ ok: true, data: { code: "ABC234" } });
    expect(seen).toEqual([{ code: "ABC234", name: "Mia" }, fake.guestId, "ip-a", "lobby:join", "string", "number"]);
  });

  it("ProtocolError → Code; unerwarteter Fehler → INTERNAL mit requestId im Log", async () => {
    const { logger, lines } = captureLogger();
    const { registry, attach } = createTestRegistry({ logger });
    registry.register("lobby:start", () => {
      throw new ProtocolError("NOT_HOST", "nur der Host");
    });
    registry.register("lobby:leave", () => {
      throw new Error("kaputt");
    });
    const fake = attach();
    expectError(await fake.call("lobby:start", {}), "NOT_HOST");
    const internal = await fake.call("lobby:leave", {});
    expectError(internal, "INTERNAL");
    if (!internal.ok) expect(internal.error.message).not.toContain("kaputt");
    const logged = lines.find((line) => line.msg === "Unerwarteter Fehler im Handler");
    expect(logged?.requestId).toEqual(expect.any(String));
    expect(logged?.event).toBe("lobby:leave");
    expect(JSON.stringify(lines)).not.toContain(fake.guestId);
  });

  it("ctx.ack() sendet sofort; spätere Fehler oder Daten erzeugen kein zweites Ack", async () => {
    const { registry, attach } = createTestRegistry();
    let effectsRan = false;
    registry.register("game:answer", async (_payload, ctx) => {
      const sent = ctx.ack({ accepted: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      effectsRan = true;
      return sent;
    });
    registry.register("game:pick", (_payload, ctx) => {
      ctx.ack(null);
      throw new ProtocolError("INVALID_PHASE");
    });
    const fake = attach();
    const acks: unknown[] = [];
    fake.receive("game:answer", { questionId: "q1", choice: 2 }, (response: unknown) => acks.push(response));
    fake.receive("game:pick", { categoryId: "comics" }, (response: unknown) => acks.push(response));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(acks).toHaveLength(2);
    expect(acks).toContainEqual({ ok: true, data: { accepted: true } });
    expect(acks).toContainEqual({ ok: true, data: null });
    expect(effectsRan).toBe(true);
  });

  it("Ack-Daten, die das Ack-Schema verletzen, werden zu INTERNAL (z. B. Richtig/Falsch im Answer-Ack)", async () => {
    const { registry, attach } = createTestRegistry();
    registry.register("game:answer", () => ({ accepted: true, correct: true }) as unknown as { accepted: true });
    registry.register("time:sync", () => ({ serverNow: -5 }));
    const fake = attach();
    expectError(await fake.call("game:answer", { questionId: "q1", choice: 0 }), "INTERNAL");
    expectError(await fake.call("time:sync", { t0: 1 }), "INTERNAL");
  });

  it("Handler über der Frist → INTERNAL, das späte Ergebnis wird verworfen", async () => {
    const { registry, attach } = createTestRegistry({ handlerTimeoutMs: 50 });
    registry.register("lobby:kick", async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return null;
    });
    const fake = attach();
    const acks: unknown[] = [];
    fake.receive("lobby:kick", { playerId: "p1" }, (response: unknown) => acks.push(response));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(acks).toHaveLength(1);
    expectError(acks[0] as AckResponse<unknown>, "INTERNAL");
  });

  it("validiert strikt: Zusatzfelder, falsche Typen, zu lange Strings, falsche Argumente → VALIDATION_FAILED", async () => {
    const { registry, attach, metrics } = createTestRegistry();
    const handler = vi.fn<EventHandler<"lobby:create">>(() => ({ code: "ABC234" }));
    registry.register("lobby:create", handler);
    registry.register("time:sync", () => ({ serverNow: 1 }));
    const fake = attach();
    const invalid: unknown[] = [
      { name: "Mia", extra: 1 },
      { name: 42 },
      { name: "x".repeat(65) },
      {},
      "Mia",
      null,
      [{ name: "Mia" }],
    ];
    for (const payload of invalid) expectError(await fake.call("lobby:create", payload), "VALIDATION_FAILED");
    const twoArgs = await new Promise<AckResponse<unknown>>((resolve) => {
      fake.receive("time:sync", { t0: 1 }, "zusätzlich", resolve);
    });
    expectError(twoArgs, "VALIDATION_FAILED");
    expect(handler).not.toHaveBeenCalled();
    expect(await metricValue(metrics, "qm_validation_failures_total", { event: "lobby:create" })).toBe(invalid.length);
    expect(fake.disconnects).toBe(0);
  });

  it("unbekannte Events (auch numerische) → VALIDATION_FAILED + Verstoß; ab dem 11. Verstoß getrennt", async () => {
    const { registry, attach, metrics } = createTestRegistry();
    registry.register("time:sync", () => ({ serverNow: 1 }));
    const fake = attach();
    for (let i = 0; i < 9; i++) expectError(await fake.call(`unknown:${i}`, {}), "VALIDATION_FAILED");
    expectError(await fake.call(42, {}), "VALIDATION_FAILED");
    expect(fake.disconnects).toBe(0);
    expectError(await fake.call("unknown:last", {}), "VALIDATION_FAILED");
    await vi.waitFor(() => expect(fake.disconnects).toBe(1));
    expect(await metricValue(metrics, "qm_violations_total", { reason: "unknown_event" })).toBe(11);
    expect(await metricValue(metrics, "qm_violation_disconnects_total")).toBe(1);
    expect(await metricValue(metrics, "qm_socket_events_total", { event: "unknown" })).toBe(11);
  });

  it("Events ohne Ack-Callback sind Verstöße", async () => {
    const { registry, attach, metrics } = createTestRegistry();
    const handler = vi.fn(() => ({ serverNow: 1 }));
    registry.register("time:sync", handler);
    const fake = attach();
    for (let i = 0; i < 11; i++) fake.receive("time:sync", { t0: 1 });
    await vi.waitFor(() => expect(fake.disconnects).toBe(1));
    expect(handler).not.toHaveBeenCalled();
    expect(await metricValue(metrics, "qm_violations_total", { reason: "missing_ack" })).toBe(11);
  });

  it("dev:add-bot ohne DEV_BOTS_ENABLED gilt als unbekannt (Verstoß)", async () => {
    const { registry, attach, metrics } = createTestRegistry({ devBots: false });
    registerAll(registry.register);
    const fake = attach();
    expectError(await fake.call("dev:add-bot", {}), "VALIDATION_FAILED");
    expect(await metricValue(metrics, "qm_violations_total", { reason: "unknown_event" })).toBe(1);
  });

  it("bekanntes Event ohne Handler → INTERNAL, aber kein Verstoß (Server-Lücke)", async () => {
    const { attach, metrics } = createTestRegistry();
    const fake = attach();
    expectError(await fake.call("lobby:create", { name: "Mia" }), "INTERNAL");
    expect(await metricValue(metrics, "qm_violations_total")).toBe(0);
  });

  it("Event-Limit (time:sync 10/10 s) → RATE_LIMITED mit retryAfterMs, zählt als Verstoß", async () => {
    const { registry, attach, metrics } = createTestRegistry();
    registry.register("time:sync", () => ({ serverNow: 1 }));
    const fake = attach();
    for (let i = 0; i < 10; i++) expect((await fake.call("time:sync", { t0: i })).ok).toBe(true);
    const limited = await fake.call("time:sync", { t0: 11 });
    expectError(limited, "RATE_LIMITED");
    if (!limited.ok) {
      expect(limited.error.retryAfterMs).toBeGreaterThan(0);
      expect(limited.error.retryAfterMs).toBeLessThanOrEqual(10_000);
    }
    expect(await metricValue(metrics, "qm_rate_limit_hits_total", { rule: "event.time-sync.socket" })).toBe(1);
    expect(await metricValue(metrics, "qm_violations_total", { reason: "rate_limit" })).toBe(1);
  });

  it("mehrere Regeln je Event: lobby:create 5/min je Gast (ADR-042)", async () => {
    const { registry, attach } = createTestRegistry();
    registry.register("lobby:create", () => ({ code: "ABC234" }));
    const guestId = randomUUID();
    const first = attach(createFakeSocket({ guestId }));
    const second = attach(createFakeSocket({ guestId }));
    for (const socket of [first, second, first, second, first]) {
      expect((await socket.call("lobby:create", { name: "Mia" })).ok).toBe(true);
    }
    expectError(await second.call("lobby:create", { name: "Mia" }), "RATE_LIMITED");
  });

  it("Fallback-Limit 30/s je Socket greift vor allen Event-Regeln", async () => {
    const { registry, attach, metrics } = createTestRegistry();
    registry.register("question:rate", () => null);
    const fake = attach();
    const acks = await Promise.all(
      Array.from({ length: 31 }, () => fake.call("question:rate", { questionId: "q1", value: 1 })),
    );
    const limited = acks.filter((ack) => !ack.ok);
    expect(limited).toHaveLength(1);
    expectError(limited[0] as AckResponse<unknown>, "RATE_LIMITED");
    expect(await metricValue(metrics, "qm_rate_limit_hits_total", { rule: "socket.any-event" })).toBe(1);
  });

  it("lobby:join: 20 Fehlversuche je IP in 5 min → 5 min Sperre (Handler nicht mehr aufgerufen, ADR-042)", async () => {
    const { registry, attach, metrics } = createTestRegistry();
    const handler = vi.fn<EventHandler<"lobby:join">>(() => {
      throw new ProtocolError("LOBBY_NOT_FOUND");
    });
    registry.register("lobby:join", handler);
    const sockets = [0, 1, 2].map(() => attach(createFakeSocket({ ipKey: "ip-guesser" })));
    const join = (fake: FakeSocket) => fake.call("lobby:join", { code: "ABC234", name: "Mia" });
    for (const fake of sockets.slice(0, 2)) {
      for (let i = 0; i < 10; i++) expectError(await join(fake), "LOBBY_NOT_FOUND");
    }
    const third = sockets[2] as FakeSocket;
    expectError(await join(third), "LOBBY_NOT_FOUND");
    expect(handler).toHaveBeenCalledTimes(21);
    const blocked = await join(third);
    expectError(blocked, "RATE_LIMITED");
    if (!blocked.ok) {
      expect(blocked.error.retryAfterMs).toBeGreaterThan(4 * 60_000);
      expect(blocked.error.retryAfterMs).toBeLessThanOrEqual(5 * 60_000);
    }
    expect(handler).toHaveBeenCalledTimes(21);
    expect(await metricValue(metrics, "qm_rate_limit_hits_total", { rule: "event.lobby-join.failed.ip" })).toBe(2);
    // Andere IP ist nicht betroffen.
    const other = attach(createFakeSocket({ ipKey: "ip-other" }));
    expectError(await join(other), "LOBBY_NOT_FOUND");
  });

  it("Fehlversuche werden VOR dem Ack verbucht – auch bei langsamem Store greift die Sperre sofort", async () => {
    const inner = createRateLimitService({ mode: "normal" });
    let booked = 0;
    // Langsamer (Mongo-)Store: das Verbuchen eines Fehlversuchs dauert 40 ms.
    const rateLimit: RateLimitService = {
      ...inner,
      async consume(rule, key, points) {
        const decision = await inner.consume(rule, key, points);
        if (rule.consume === "failure") {
          await new Promise((resolve) => setTimeout(resolve, 40));
          booked += 1;
        }
        return decision;
      },
    };
    const { registry, attach } = createTestRegistry({ rateLimit });
    const handler = vi.fn<EventHandler<"lobby:join">>(() => {
      throw new ProtocolError("LOBBY_NOT_FOUND");
    });
    registry.register("lobby:join", handler);
    const sockets = [0, 1, 2].map(() => attach(createFakeSocket({ ipKey: "ip-fast-guesser" })));
    const join = (fake: FakeSocket) => fake.call("lobby:join", { code: "ABC234", name: "Mia" });

    expectError(await join(sockets[0] as FakeSocket), "LOBBY_NOT_FOUND");
    expect(booked).toBe(1);

    for (let i = 1; i < 21; i++) expectError(await join(sockets[Math.floor(i / 10)] as FakeSocket), "LOBBY_NOT_FOUND");
    expect(booked).toBe(21);
    expect(handler).toHaveBeenCalledTimes(21);
    // Direkt nach dem Ack des 21. Fehlversuchs: gesperrt, mit (fast) voller Sperrdauer.
    const blocked = await join(sockets[2] as FakeSocket);
    expectError(blocked, "RATE_LIMITED");
    if (!blocked.ok) {
      expect(blocked.error.retryAfterMs).toBeGreaterThan(4 * 60_000);
      expect(blocked.error.retryAfterMs).toBeLessThanOrEqual(5 * 60_000);
    }
    expect(handler).toHaveBeenCalledTimes(21);
  });

  it("ein Fehler beim Verbuchen ändert das Ack nicht (fachlicher Code statt INTERNAL)", async () => {
    const inner = createRateLimitService({ mode: "normal" });
    const rateLimit: RateLimitService = {
      ...inner,
      async consume(rule, key, points) {
        if (rule.consume === "failure") throw new Error("Store kaputt");
        return inner.consume(rule, key, points);
      },
    };
    const { registry, attach } = createTestRegistry({ rateLimit });
    registry.register("lobby:join", () => {
      throw new ProtocolError("LOBBY_NOT_FOUND");
    });
    expectError(await attach().call("lobby:join", { code: "ABC234", name: "Mia" }), "LOBBY_NOT_FOUND");
  });

  it("ein fachlicher Fehler NACH einem Erfolgs-Ack zählt nicht als Fehlversuch", async () => {
    const { registry, attach } = createTestRegistry();
    const handler = vi.fn<EventHandler<"lobby:join">>((_payload, ctx) => {
      ctx.ack({ code: "ABC234" });
      throw new ProtocolError("LOBBY_NOT_FOUND");
    });
    registry.register("lobby:join", handler);
    const sockets = [0, 1, 2].map(() => attach(createFakeSocket({ ipKey: "ip-after-ack" })));
    const join = (index: number) =>
      (sockets[Math.floor(index / 10)] as FakeSocket).call("lobby:join", { code: "ABC234", name: "Mia" });
    for (let i = 0; i < 21; i++) expect((await join(i)).ok).toBe(true);
    // Etwaige Verbuchungen nach dem Ack abwarten – danach darf trotzdem keine Sperre bestehen.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await join(21)).ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(22);
  });

  it("lobby:resume hat eine eigene Fehlversuchs-Regel je IP (Code-Raten über resume)", async () => {
    const { registry, attach } = createTestRegistry();
    const handler = vi.fn<EventHandler<"lobby:resume">>(() => {
      throw new ProtocolError("LOBBY_NOT_FOUND");
    });
    registry.register("lobby:resume", handler);
    const sockets = [0, 1, 2].map(() => attach(createFakeSocket({ ipKey: "ip-resumer" })));
    for (let i = 0; i < 21; i++) {
      expectError(
        await (sockets[Math.floor(i / 10)] as FakeSocket).call("lobby:resume", { code: "ABC234" }),
        "LOBBY_NOT_FOUND",
      );
    }
    const blocked = await (sockets[2] as FakeSocket).call("lobby:resume", { code: "ABC234" });
    expectError(blocked, "RATE_LIMITED");
    if (!blocked.ok) {
      expect(blocked.error.retryAfterMs).toBeGreaterThan(4 * 60_000);
      expect(blocked.error.retryAfterMs).toBeLessThanOrEqual(5 * 60_000);
    }
    expect(handler).toHaveBeenCalledTimes(21);
    // lobby:join zählt getrennt (eigene Regel).
    registry.register("lobby:join", () => ({ code: "ABC234" }));
    expect((await (sockets[2] as FakeSocket).call("lobby:join", { code: "ABC234", name: "Mia" })).ok).toBe(true);
  });

  it("IP-Sperre einer Fehlversuchs-Regel ist kein Verstoß des einzelnen Sockets (Unbeteiligte derselben IP)", async () => {
    const { registry, attach, metrics } = createTestRegistry();
    registry.register("lobby:resume", () => {
      throw new ProtocolError("LOBBY_NOT_FOUND");
    });
    const guessers = [0, 1, 2].map(() => attach(createFakeSocket({ ipKey: "ip-shared" })));
    for (let i = 0; i < 21; i++) {
      expectError(
        await (guessers[Math.floor(i / 10)] as FakeSocket).call("lobby:resume", { code: "ABC234" }),
        "LOBBY_NOT_FOUND",
      );
    }
    const violationsBefore = await metricValue(metrics, "qm_violations_total", { reason: "rate_limit" });
    // Unbeteiligte Person derselben IP versucht es zehnmal (Socket-Limit 10/min) – gesperrt, aber kein Verstoß.
    const bystander = attach(createFakeSocket({ ipKey: "ip-shared" }));
    for (let i = 0; i < 10; i++) {
      expectError(await bystander.call("lobby:resume", { code: "XYZ789" }), "RATE_LIMITED");
    }
    expect(await metricValue(metrics, "qm_violations_total", { reason: "rate_limit" })).toBe(violationsBefore);
    expect(bystander.disconnects).toBe(0);
    // Fluten zählen weiter über die Socket-Regel derselben Events (11. Versuch in der Minute → Verstoß).
    expectError(await bystander.call("lobby:resume", { code: "XYZ789" }), "RATE_LIMITED");
    expect(await metricValue(metrics, "qm_violations_total", { reason: "rate_limit" })).toBe(violationsBefore + 1);
  });

  it("skipFailureBlock: wer die Sperre nicht betrifft (z. B. Mitglied der Lobby), erreicht den Handler", async () => {
    const { registry, attach } = createTestRegistry();
    const member = randomUUID();
    const handler = vi.fn<EventHandler<"lobby:resume">>((payload, ctx) => {
      if (ctx.guestId === member && payload.code === "ABC234") return { code: "ABC234" };
      throw new ProtocolError("LOBBY_NOT_FOUND");
    });
    const skip = vi.fn((payload: { code: string }, guestId: string) => guestId === member && payload.code === "ABC234");
    registry.register("lobby:resume", handler, {
      countsAsFailure: (code) => code === "LOBBY_NOT_FOUND",
      skipFailureBlock: skip,
    });
    const guessers = [0, 1, 2].map(() => attach(createFakeSocket({ ipKey: "ip-member" })));
    for (let i = 0; i < 21; i++) {
      expectError(
        await (guessers[Math.floor(i / 10)] as FakeSocket).call("lobby:resume", { code: "XYZ789" }),
        "LOBBY_NOT_FOUND",
      );
    }
    expectError(await (guessers[2] as FakeSocket).call("lobby:resume", { code: "ABC234" }), "RATE_LIMITED");
    const own = attach(createFakeSocket({ guestId: member, ipKey: "ip-member" }));
    expect(await own.call("lobby:resume", { code: "ABC234" })).toEqual({ ok: true, data: { code: "ABC234" } });
    // Ein fremder Code bleibt für dieselbe Person gesperrt (kein Umweg zum Raten).
    expectError(await own.call("lobby:resume", { code: "XYZ789" }), "RATE_LIMITED");
    expect(handler).toHaveBeenCalledTimes(22);
    expect(skip).toHaveBeenCalledWith({ code: "ABC234" }, member);
  });

  it("isFailedAttempt: fachliche Ablehnungen zählen, Server-Zustände nicht", () => {
    for (const code of ["LOBBY_NOT_FOUND", "LOBBY_FULL", "GAME_IN_PROGRESS", "KICKED", "NAME_REJECTED"] as const) {
      expect(isFailedAttempt(code)).toBe(true);
    }
    for (const code of ["INTERNAL", "SERVER_BUSY", "RATE_LIMITED", "TURNSTILE_REQUIRED"] as const) {
      expect(isFailedAttempt(code)).toBe(false);
    }
  });

  it("im Shutdown wird lobby:create mit SERVER_BUSY beantwortet, andere Events laufen weiter", async () => {
    let shuttingDown = false;
    const { registry, attach } = createTestRegistry({ shuttingDown: () => shuttingDown });
    const create = vi.fn(() => ({ code: "ABC234" }));
    registry.register("lobby:create", create);
    registry.register("time:sync", () => ({ serverNow: 1 }));
    const fake = attach();
    shuttingDown = true;
    expectError(await fake.call("lobby:create", { name: "Mia" }), "SERVER_BUSY");
    expect(create).not.toHaveBeenCalled();
    expect((await fake.call("time:sync", { t0: 1 })).ok).toBe(true);
  });

  it("4 Verstoß-Trennungen eines Gasts in 10 min → Gast 15 min gesperrt", async () => {
    const { attach, banned } = createTestRegistry();
    const guestId = randomUUID();
    for (let round = 1; round <= 4; round++) {
      const fake = attach(createFakeSocket({ guestId }));
      for (let i = 0; i < 11; i++) await fake.call("nope", {});
      await vi.waitFor(() => expect(fake.disconnects).toBe(1));
      if (round < 4) expect(banned).toEqual([]);
    }
    await vi.waitFor(() => expect(banned).toEqual([{ guestId, durationSec: 900, reason: "violations" }]));
  });
});

describe("Produktionsstart (Invariante 6 zur Laufzeit)", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase({ ensureIndexes: true });
  });
  afterAll(() => database?.cleanup());

  const envFor = () => {
    const secret = (char: string) => char.repeat(40);
    const parsed = parseRealtimeEnv({
      REALTIME_PORT: String(DEFAULT_TEST_PORTS.from),
      APP_ORIGIN: "http://localhost:3000",
      MONGODB_URI: database.uri,
      MONGODB_DB: database.dbName,
      MONGODB_COLLECTION_PREFIX: database.prefix,
      REALTIME_TICKET_SECRET: secret("a"),
      IP_HASH_SECRET: secret("b"),
      METRICS_TOKEN: secret("c"),
      LOG_LEVEL: "silent",
    });
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    // Wie eine Produktions-Datenbank behandeln (nur die Registry-Regel wird hier geprüft).
    return { ...parsed.env, databaseKind: "production" as const };
  };

  const dbFor = () => ({
    client: database.client,
    db: database.db,
    collections: database.collections,
    repos: createRepositories(database.client, database.collections),
    prefix: database.prefix,
  });

  const ports = Array.from(
    { length: DEFAULT_TEST_PORTS.to - DEFAULT_TEST_PORTS.from + 1 },
    (_, i) => DEFAULT_TEST_PORTS.from + i,
  );

  it("bricht ab, wenn ein Event aus CLIENT_EVENTS keinen Handler hat", async () => {
    const app = await createRealtimeApp({
      env: envFor(),
      db: dbFor(),
      logger: createSilentLogger(),
      modules: [timeSyncModule],
    });
    try {
      await expect(app.start({ port: ports })).rejects.toThrow(/Kein Handler für: .*lobby:create/);
    } finally {
      await app.stop("test");
    }
  });

  it("startet, wenn alle Events Handler haben", async () => {
    const everything: RealtimeModule = {
      name: "alle-events",
      setup: ({ registerEvent }) => {
        for (const event of CLIENT_EVENT_NAMES) {
          if (event === "time:sync") continue;
          registerEvent(event, () => SAMPLE_ACK[event]);
        }
      },
    };
    const app = await createRealtimeApp({
      env: envFor(),
      db: dbFor(),
      logger: createSilentLogger(),
      modules: [timeSyncModule, everything],
    });
    try {
      const address = await app.start({ port: ports });
      expect(address.port).toBeGreaterThanOrEqual(DEFAULT_TEST_PORTS.from);
      expect(app.registry.missingHandlers()).toEqual([]);
    } finally {
      await app.stop("test");
    }
  });
});
