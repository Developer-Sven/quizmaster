import { describe, expect, it } from "vitest";
import { CLIENT_EVENT_NAMES } from "./events.ts";
import { HTTP_ENDPOINTS } from "./http.ts";
import {
  CONNECTION_LIMITS,
  LOAD_SHEDDING,
  QUOTAS,
  RATE_LIMITS,
  type RateLimitRule,
  rateLimitsFor,
  SPECIAL_LIMIT_TARGETS,
  toRateLimiterOptions,
} from "./limits.ts";

describe("Vollständigkeit (docs/06 Invariante 6)", () => {
  it("jedes Client→Server-Event der Registry hat mindestens ein Limit", () => {
    expect(CLIENT_EVENT_NAMES).toHaveLength(17);
    for (const event of CLIENT_EVENT_NAMES) expect(rateLimitsFor(event).length, event).toBeGreaterThan(0);
  });

  it("jeder HTTP-Endpunkt hat mindestens ein Limit", () => {
    expect(HTTP_ENDPOINTS).toEqual([
      "POST /api/session",
      "POST /api/realtime/ticket",
      "GET /api/categories",
      "GET /api/health",
      "GET /healthz",
      "GET /metrics",
    ]);
    for (const endpoint of HTTP_ENDPOINTS) expect(rateLimitsFor(endpoint).length, endpoint).toBeGreaterThan(0);
  });

  it("Handshakes, Fallback je Socket, Verstöße und Gast-Sperren sind konfiguriert", () => {
    for (const target of SPECIAL_LIMIT_TARGETS) expect(rateLimitsFor(target).length, target).toBe(1);
  });

  it("jede Regel gehört zu einem bekannten Ziel und hat eine eindeutige ID", () => {
    const targets = new Set<string>([...CLIENT_EVENT_NAMES, ...HTTP_ENDPOINTS, ...SPECIAL_LIMIT_TARGETS]);
    for (const entry of RATE_LIMITS) expect(targets.has(entry.target), entry.id).toBe(true);
    expect(new Set(RATE_LIMITS.map((entry) => entry.id)).size).toBe(RATE_LIMITS.length);
  });

  it("alle Werte sind positive ganze Zahlen", () => {
    for (const entry of RATE_LIMITS) {
      expect(Number.isInteger(entry.points) && entry.points > 0, entry.id).toBe(true);
      expect(Number.isInteger(entry.durationSec) && entry.durationSec > 0, entry.id).toBe(true);
      expect(Number.isInteger(entry.blockDurationSec) && entry.blockDurationSec >= 0, entry.id).toBe(true);
    }
  });
});

type Expected = [
  target: RateLimitRule["target"],
  scope: RateLimitRule["scope"],
  points: number,
  durationSec: number,
  blockDurationSec: number,
  store: RateLimitRule["store"],
  onExceed: RateLimitRule["onExceed"],
];

const ACK = { action: "ack_error", code: "RATE_LIMITED" } as const;
const HTTP = { action: "http_error", status: 429, retryAfterHeader: true } as const;

/** Die Tabelle aus docs/06 Zeile für Zeile. */
const EXPECTED: Record<string, Expected> = {
  "http.session.ip": ["POST /api/session", "ip", 30, 600, 0, "mongo", HTTP],
  "http.ticket.guest": ["POST /api/realtime/ticket", "guest", 30, 60, 0, "memory", HTTP],
  "http.ticket.ip": ["POST /api/realtime/ticket", "ip", 300, 60, 0, "memory", HTTP],
  "http.categories.ip": ["GET /api/categories", "ip", 60, 60, 0, "memory", HTTP],
  "http.health.ip": ["GET /api/health", "ip", 60, 60, 0, "memory", HTTP],
  "http.healthz.ip": ["GET /healthz", "ip", 60, 60, 0, "memory", HTTP],
  "http.metrics.ip": ["GET /metrics", "ip", 30, 60, 0, "memory", HTTP],
  "socket.handshake.ip": [
    "socket:handshake",
    "ip",
    60,
    60,
    0,
    "memory",
    { action: "reject_handshake", code: "RATE_LIMITED" },
  ],
  "event.time-sync.socket": ["time:sync", "socket", 10, 10, 0, "memory", ACK],
  "event.lobby-create.guest.minute": ["lobby:create", "guest", 5, 60, 0, "mongo", ACK],
  "event.lobby-create.guest.day": ["lobby:create", "guest", 60, 86_400, 0, "mongo", ACK],
  "event.lobby-create.ip.hour": ["lobby:create", "ip", 60, 3_600, 0, "mongo", ACK],
  "event.lobby-join.failed.ip": ["lobby:join", "ip", 20, 300, 300, "mongo", ACK],
  "event.lobby-join.socket": ["lobby:join", "socket", 20, 60, 0, "memory", ACK],
  "event.lobby-resume.failed.ip": ["lobby:resume", "ip", 20, 300, 300, "mongo", ACK],
  "event.lobby-resume.socket": ["lobby:resume", "socket", 10, 60, 0, "memory", ACK],
  "event.lobby-leave.socket": ["lobby:leave", "socket", 10, 60, 0, "memory", ACK],
  "event.lobby-update-settings.socket": ["lobby:update-settings", "socket", 40, 10, 0, "memory", ACK],
  "event.lobby-rename.socket": ["lobby:rename", "socket", 5, 60, 0, "memory", ACK],
  "event.lobby-kick.socket": ["lobby:kick", "socket", 10, 60, 0, "memory", ACK],
  "event.lobby-start.socket": ["lobby:start", "socket", 10, 60, 0, "memory", ACK],
  "event.game-rematch.socket": ["game:rematch", "socket", 5, 60, 0, "memory", ACK],
  "event.game-continue.socket": ["game:continue", "socket", 10, 10, 0, "memory", ACK],
  "event.dev-add-bot.socket": ["dev:add-bot", "socket", 10, 60, 0, "memory", ACK],
  "event.game-answer.once": [
    "game:answer",
    "player_question",
    1,
    60,
    0,
    "memory",
    { action: "ack_error", code: "ALREADY_ANSWERED" },
  ],
  "event.game-answer.socket": ["game:answer", "socket", 5, 1, 0, "memory", ACK],
  "event.game-pick.socket": ["game:pick", "socket", 5, 5, 0, "memory", ACK],
  "event.game-review.socket": ["game:review", "socket", 20, 60, 0, "memory", ACK],
  "event.question-rate.guest": ["question:rate", "guest", 60, 600, 0, "memory", ACK],
  "event.question-report.guest": ["question:report", "guest", 10, 600, 0, "memory", ACK],
  "socket.any-event": ["socket:any-event", "socket", 30, 1, 0, "memory", ACK],
  "socket.violations": ["socket:violation", "socket", 10, 60, 0, "memory", { action: "disconnect" }],
  "guest.violation-disconnects": [
    "guest:violation-disconnect",
    "guest",
    3,
    600,
    0,
    "mongo",
    { action: "ban_guest", banDurationSec: 900 },
  ],
};

describe("Werte (docs/06 §Rate-Limits & Kontingente)", () => {
  it("entsprechen der Tabelle – jede Regel genau einmal", () => {
    expect(RATE_LIMITS.map((entry) => entry.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const entry of RATE_LIMITS) {
      const expected = EXPECTED[entry.id];
      if (!expected) throw new Error(`unerwartete Regel ${entry.id}`);
      const [target, scope, points, durationSec, blockDurationSec, store, onExceed] = expected;
      expect(
        {
          target: entry.target,
          scope: entry.scope,
          points: entry.points,
          durationSec: entry.durationSec,
          blockDurationSec: entry.blockDurationSec,
          store: entry.store,
          onExceed: entry.onExceed,
        },
        entry.id,
      ).toEqual({ target, scope, points, durationSec, blockDurationSec, store, onExceed });
    }
  });

  it("zählt bei lobby:join und lobby:resume je IP nur Fehlversuche; die Antwort-Idempotenz setzt die Engine durch", () => {
    const failureRules = RATE_LIMITS.filter((entry) => entry.consume === "failure");
    expect(failureRules.map((entry) => [entry.id, entry.target, entry.scope])).toEqual([
      ["event.lobby-join.failed.ip", "lobby:join", "ip"],
      ["event.lobby-resume.failed.ip", "lobby:resume", "ip"],
    ]);
    expect(RATE_LIMITS.filter((entry) => entry.kind === "once").map((entry) => entry.id)).toEqual([
      "event.game-answer.once",
    ]);
  });

  it("Limit-Treffer bei Socket-Events zählen als Verstoß, HTTP und Handshakes nicht", () => {
    for (const entry of RATE_LIMITS) {
      const isSocketEvent = (CLIENT_EVENT_NAMES as readonly string[]).includes(entry.target);
      if (isSocketEvent && entry.kind === "rate") expect(entry.countsAsViolation, entry.id).toBe(true);
      if (entry.target.includes("/")) expect(entry.countsAsViolation, entry.id).toBe(false);
    }
  });

  it("liefert Optionen für rate-limiter-flexible", () => {
    const [first] = rateLimitsFor("POST /api/session");
    if (!first) throw new Error("Regel fehlt");
    expect(toRateLimiterOptions(first)).toEqual({
      keyPrefix: "qm:http.session.ip",
      points: 30,
      duration: 600,
      blockDuration: 0,
    });
  });

  it("begrenzt gleichzeitige Sockets, Lobbys und Last", () => {
    expect(CONNECTION_LIMITS.perGuest).toEqual({ max: 5, onExceed: "TOO_MANY_CONNECTIONS" });
    expect(CONNECTION_LIMITS.perIp).toEqual({ max: 100, onExceed: "TOO_MANY_CONNECTIONS" });
    expect(CONNECTION_LIMITS.global).toEqual({ env: "MAX_CONNECTIONS", defaultMax: 20_000, onExceed: "SERVER_BUSY" });
    expect(QUOTAS.maxActiveLobbies.defaultMax).toBe(5_000);
    expect(QUOTAS.maxPlayersPerLobby).toEqual({ max: 8, onExceed: "LOBBY_FULL" });
    expect(QUOTAS.maxActiveHostedLobbiesPerGuest.max).toBe(1);
    expect(LOAD_SHEDDING).toEqual({ eventLoopDelayP99Ms: 200, onExceed: "SERVER_BUSY" });
  });
});
