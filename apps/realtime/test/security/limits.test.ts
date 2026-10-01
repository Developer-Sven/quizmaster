/**
 * Invariante 6 (docs/06, docs/11 §Sicherheits-Invarianten 6): Jedes registrierte Event und jeder HTTP-Endpunkt
 * hat ein Rate-Limit nach der Tabelle in docs/06 – geprüft gegen die Tabelle UND gegen den laufenden Server mit
 * den Produktions-Modulen. Dazu je Event ein Flut-Test (→ RATE_LIMITED mit retryAfterMs, nachweislich vom
 * Limiter: Metrik je Regel) und die Eskalation über den Fallback (30/s) bis zur Trennung.
 */
import { randomUUID } from "node:crypto";
import {
  CLIENT_EVENT_NAMES,
  CLIENT_EVENTS,
  type ClientEventName,
  HTTP_ENDPOINTS,
  RATE_LIMITS,
  type RateLimitRule,
  SPECIAL_LIMIT_TARGETS,
} from "@quizmaster/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emitRawWithAck, metricValue, type TestClient, type TestServer, waitForDisconnect } from "../helpers/index.ts";
import { rateRulesFor, startSecurityServer, VALID_PAYLOADS } from "./support.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/** docs/06 §Rate-Limits & Kontingente als Erwartung: Ziel, Schlüssel, Punkte, Fenster (s), Store. */
const DOCS_TABLE: ReadonlyArray<{
  target: string;
  scope: RateLimitRule["scope"];
  points: number;
  durationSec: number;
  store?: RateLimitRule["store"];
  consume?: RateLimitRule["consume"];
  blockDurationSec?: number;
}> = [
  { target: "POST /api/session", scope: "ip", points: 10, durationSec: 600, store: "mongo" },
  { target: "POST /api/realtime/ticket", scope: "guest", points: 30, durationSec: 60 },
  { target: "POST /api/realtime/ticket", scope: "ip", points: 300, durationSec: 60 },
  { target: "GET /api/categories", scope: "ip", points: 60, durationSec: 60 },
  { target: "GET /api/health", scope: "ip", points: 60, durationSec: 60 },
  { target: "GET /healthz", scope: "ip", points: 60, durationSec: 60 },
  { target: "GET /metrics", scope: "ip", points: 30, durationSec: 60 },
  { target: "socket:handshake", scope: "ip", points: 60, durationSec: 60 },
  { target: "lobby:create", scope: "guest", points: 3, durationSec: 60, store: "mongo" },
  { target: "lobby:create", scope: "guest", points: 30, durationSec: 86_400, store: "mongo" },
  { target: "lobby:create", scope: "ip", points: 30, durationSec: 3_600, store: "mongo" },
  {
    target: "lobby:join",
    scope: "ip",
    points: 20,
    durationSec: 300,
    store: "mongo",
    consume: "failure",
    blockDurationSec: 900,
  },
  { target: "lobby:join", scope: "socket", points: 10, durationSec: 60 },
  { target: "lobby:resume", scope: "socket", points: 10, durationSec: 60 },
  { target: "lobby:update-settings", scope: "socket", points: 10, durationSec: 10 },
  { target: "lobby:kick", scope: "socket", points: 10, durationSec: 60 },
  { target: "lobby:start", scope: "socket", points: 5, durationSec: 60 },
  { target: "game:rematch", scope: "socket", points: 5, durationSec: 60 },
  { target: "lobby:leave", scope: "socket", points: 10, durationSec: 60 },
  { target: "dev:add-bot", scope: "socket", points: 10, durationSec: 60 },
  { target: "game:answer", scope: "socket", points: 5, durationSec: 1 },
  { target: "game:pick", scope: "socket", points: 5, durationSec: 5 },
  { target: "game:review", scope: "socket", points: 5, durationSec: 60 },
  { target: "question:rate", scope: "guest", points: 60, durationSec: 600 },
  { target: "question:report", scope: "guest", points: 5, durationSec: 600 },
  { target: "time:sync", scope: "socket", points: 10, durationSec: 10 },
  { target: "socket:any-event", scope: "socket", points: 30, durationSec: 1 },
  { target: "socket:violation", scope: "socket", points: 10, durationSec: 60 },
  { target: "guest:violation-disconnect", scope: "guest", points: 3, durationSec: 600, store: "mongo" },
];

describe("Invariante 6 – Tabelle (docs/06)", () => {
  it("jede Zeile der docs/06-Tabelle steht mit diesen Werten in RATE_LIMITS", () => {
    for (const row of DOCS_TABLE) {
      const match = rateRulesFor(row.target).find(
        (rule) =>
          rule.scope === row.scope &&
          rule.points === row.points &&
          rule.durationSec === row.durationSec &&
          rule.store === (row.store ?? "memory") &&
          rule.consume === (row.consume ?? "attempt") &&
          rule.blockDurationSec === (row.blockDurationSec ?? 0),
      );
      expect(match, `${row.target} (${row.scope} ${row.points}/${row.durationSec}s)`).toBeDefined();
    }
  });

  it("jedes Event aus CLIENT_EVENTS hat ein Zeitfenster-Limit mit RATE_LIMITED + Verstoß; game:answer zusätzlich „einmal“", () => {
    for (const event of CLIENT_EVENT_NAMES) {
      const rules = rateRulesFor(event);
      expect(rules.length, event).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(rule.onExceed, rule.id).toEqual({ action: "ack_error", code: "RATE_LIMITED" });
        expect(rule.countsAsViolation, rule.id).toBe(true);
      }
    }
    expect(RATE_LIMITS.find((rule) => rule.id === "event.game-answer.once")).toMatchObject({
      kind: "once",
      scope: "player_question",
      onExceed: { action: "ack_error", code: "ALREADY_ANSWERED" },
    });
  });

  it("jeder HTTP-Endpunkt (Web und Realtime) hat ein Limit mit 429 + Retry-After", () => {
    expect([...HTTP_ENDPOINTS].sort()).toEqual(
      [
        "GET /api/categories",
        "GET /api/health",
        "GET /healthz",
        "GET /metrics",
        "POST /api/realtime/ticket",
        "POST /api/session",
      ].sort(),
    );
    for (const endpoint of HTTP_ENDPOINTS) {
      const rules = rateRulesFor(endpoint);
      expect(rules.length, endpoint).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(rule.onExceed, rule.id).toEqual({ action: "http_error", status: 429, retryAfterHeader: true });
      }
    }
  });

  it("Sonderziele: Handshake abgelehnt, Fallback zählt als Verstoß, Verstöße trennen, Trennungen sperren 15 min", () => {
    for (const target of SPECIAL_LIMIT_TARGETS) expect(rateRulesFor(target).length, target).toBeGreaterThan(0);
    expect(rateRulesFor("socket:handshake")[0]?.onExceed).toEqual({ action: "reject_handshake", code: "RATE_LIMITED" });
    expect(rateRulesFor("socket:any-event")[0]?.countsAsViolation).toBe(true);
    expect(rateRulesFor("socket:violation")[0]?.onExceed).toEqual({ action: "disconnect" });
    expect(rateRulesFor("guest:violation-disconnect")[0]?.onExceed).toEqual({
      action: "ban_guest",
      banDurationSec: 900,
    });
  });

  it("IDs sind eindeutig, jede Regel hat ein bekanntes Ziel", () => {
    const ids = RATE_LIMITS.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    const targets = new Set<string>([...CLIENT_EVENT_NAMES, ...HTTP_ENDPOINTS, ...SPECIAL_LIMIT_TARGETS]);
    for (const rule of RATE_LIMITS) expect(targets.has(rule.target), rule.id).toBe(true);
  });
});

/** Strengste Versuchs-Regel eines Events (wenigste Punkte) – sie greift bei einer Flut zuerst. */
function strictestAttemptRule(server: TestServer, event: ClientEventName): RateLimitRule {
  const rules = server.app.registry.limitsOf(event).filter((rule) => rule.consume === "attempt");
  const [first, ...rest] = rules;
  if (first === undefined) throw new Error(`${event}: keine Versuchs-Regel`);
  return rest.reduce((best, rule) => (rule.points < best.points ? rule : best), first);
}

/**
 * Payload für die Flut: gültig geformt, fachlich ohne Wirkung (keine Lobby → LOBBY_NOT_FOUND usw.).
 * `lobby:create` mit reserviertem Namen (NAME_REJECTED) – sonst entstünde bei Versuch 1 eine Lobby.
 */
function floodPayload(event: ClientEventName): unknown {
  if (event === "lobby:create") return { name: "admin" };
  return VALID_PAYLOADS[event];
}

describe("Invariante 6 – laufender Server (Produktions-Module)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startSecurityServer({ devBots: true });
  });
  afterAll(() => server?.cleanup());

  it("Registry = CLIENT_EVENTS (mit Dev-Bots), jedes registrierte Event mit Limit, keine Lücke", () => {
    const registered = server.app.registry.registeredEvents();
    expect(new Set(registered)).toEqual(new Set(CLIENT_EVENT_NAMES));
    expect(server.app.registry.missingHandlers()).toEqual([]);
    for (const event of registered) {
      const limits = server.app.registry.limitsOf(event);
      expect(limits.length, event).toBeGreaterThan(0);
      expect(limits.every((rule) => rule.kind === "rate")).toBe(true);
    }
    // Das Fallback-Limit gilt zusätzlich für jedes Event (auch unbekannte).
    expect(server.app.services.rateLimit.rule("socket.any-event")).toMatchObject({ points: 30, durationSec: 1 });
  });

  for (const event of CLIENT_EVENT_NAMES) {
    it(`Flut ${event} → RATE_LIMITED vom Limiter (genau ab Punkt points + 1)`, async () => {
      const rule = strictestAttemptRule(server, event);
      const guestId = randomUUID();
      // Bei vielen Punkten auf mehrere Sockets desselben Gasts verteilen (Fallback 30/s je Socket nicht auslösen).
      const socketCount = rule.scope === "socket" ? 1 : Math.min(5, Math.ceil((rule.points + 1) / 20));
      const ip = server.nextIp();
      const clients: TestClient[] = [];
      for (let i = 0; i < socketCount; i++) clients.push(await server.connectClient({ guestId, ip }));
      const hitsBefore = await metricValue(server.app.services.metrics, "qm_rate_limit_hits_total", { rule: rule.id });
      const codes: string[] = [];
      let limited: { retryAfterMs?: number } | undefined;
      for (let attempt = 0; attempt <= rule.points; attempt++) {
        const client = clients[attempt % clients.length] as TestClient;
        const ack = (await emitRawWithAck(client.socket, event, [floodPayload(event)])) as {
          ok: boolean;
          error?: { code: string; retryAfterMs?: number };
        };
        const code = ack.ok ? "ok" : (ack.error?.code ?? "?");
        codes.push(code);
        if (attempt === rule.points) limited = ack.error;
      }
      expect(codes.slice(0, rule.points), `${event}: vor der Grenze`).not.toContain("RATE_LIMITED");
      expect(codes.at(-1), `${event}: Versuch ${rule.points + 1}`).toBe("RATE_LIMITED");
      expect(limited?.retryAfterMs ?? 0).toBeGreaterThan(0);
      expect(limited?.retryAfterMs ?? 0).toBeLessThanOrEqual((rule.durationSec + rule.blockDurationSec) * 1_000);
      expect(await metricValue(server.app.services.metrics, "qm_rate_limit_hits_total", { rule: rule.id })).toBe(
        hitsBefore + 1,
      );
      // Ein einzelner Limit-Treffer ist ein Verstoß, aber noch kein Grund zur Trennung.
      for (const client of clients) {
        expect(client.socket.connected).toBe(true);
        expect(client.contractViolations).toEqual([]);
        client.close();
      }
      expect(CLIENT_EVENTS[event]).toBeDefined();
    });
  }

  it("Fallback 30/s je Socket über verschiedene Events → RATE_LIMITED, weitere Flut → Trennung", async () => {
    const client = await server.connectClient();
    const before = await metricValue(server.app.services.metrics, "qm_rate_limit_hits_total", {
      rule: "socket.any-event",
    });
    // Je Event unter seinem eigenen Limit bleiben: 9 + 9 + 9 + 4 = 31 Events in derselben Sekunde.
    const plan: ClientEventName[] = [
      ...Array<ClientEventName>(9).fill("time:sync"),
      ...Array<ClientEventName>(9).fill("lobby:leave"),
      ...Array<ClientEventName>(9).fill("lobby:kick"),
      ...Array<ClientEventName>(4).fill("game:review"),
    ];
    const codes = await Promise.all(
      plan.map(async (event) => {
        const ack = (await emitRawWithAck(client.socket, event, [VALID_PAYLOADS[event]])) as {
          ok: boolean;
          error?: { code: string };
        };
        return ack.ok ? "ok" : (ack.error?.code ?? "?");
      }),
    );
    expect(codes.filter((code) => code === "RATE_LIMITED").length).toBeGreaterThanOrEqual(1);
    expect(
      await metricValue(server.app.services.metrics, "qm_rate_limit_hits_total", { rule: "socket.any-event" }),
    ).toBeGreaterThan(before);
    // Weiter fluten: jeder Treffer ist ein Verstoß, ab dem 11. in einer Minute wird getrennt.
    const gone = waitForDisconnect(client.socket, 10_000);
    for (let i = 0; i < 40 && client.socket.connected; i++) {
      await emitRawWithAck(client.socket, "time:sync", [{ t0: i }], 2_000).catch(() => undefined);
    }
    expect(await gone).toBe("io server disconnect");
    const health = await server.request("/healthz");
    expect(health.status).toBe(200);
  });
});

describe("HTTP-Endpunkte des Realtime-Servers (Flut)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startSecurityServer({ seed: false });
  });
  afterAll(() => server?.cleanup());

  it("/healthz: 60 je Minute und IP, dann 429 mit Retry-After; andere IPs frei", async () => {
    const ip = server.nextIp();
    for (let i = 0; i < 60; i++) expect((await server.request("/healthz", { ip })).status).toBe(200);
    const limited = await server.request("/healthz", { ip });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect((await server.request("/healthz")).status).toBe(200);
  });

  it("/metrics: 30 je Minute und IP – auch ohne Token gezählt (kein Brute-Force des Tokens), dann 429", async () => {
    const ip = server.nextIp();
    for (let i = 0; i < 30; i++) {
      expect((await server.request("/metrics", { ip, headers: { authorization: "Bearer falsch" } })).status).toBe(401);
    }
    const limited = await server.request("/metrics", {
      ip,
      headers: { authorization: `Bearer ${server.secrets.metricsToken}` },
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("alle anderen Pfade und Methoden → 404 ohne Details", async () => {
    for (const path of ["/", "/api/session", "/admin", "/socket.io.js"]) {
      const response = await server.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.text()).toBe("Not Found");
    }
    expect((await server.request("/healthz", { method: "POST" })).status).toBe(404);
  });
});
