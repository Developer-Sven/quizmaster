/**
 * Rate-Limits & Kontingente (docs/06 §Rate-Limits & Kontingente) als typisierte Daten – direkt nutzbar
 * für `rate-limiter-flexible` (`toRateLimiterOptions`). Jedes Client→Server-Event und jeder HTTP-Endpunkt
 * hat mindestens eine Regel (Test in `limits.test.ts`, docs/06 Invariante 6).
 *
 * Speicher: `memory` für den Hot Path (Socket-Events), `mongo` (Collection `rateLimits`, mit
 * Memory-`insuranceLimiter`) für sicherheitsrelevante, verteilte Zähler: Session, Lobby-Erstellung,
 * Fehlversuche, Verstoß-Trennungen.
 *
 * IP-Schlüssel: nie die rohe IP – `HMAC-SHA256(IP_HASH_SECRET, ip)` gekürzt, bei IPv6 das /64-Präfix;
 * die IP stammt nur aus `TRUSTED_IP_HEADER`, wenn der Origin abgeschottet ist (docs/06 §IP-Adressen).
 */

import type { ErrorCode } from "./errors.ts";
import type { ClientEventName } from "./events.ts";
import type { HttpEndpoint } from "./http.ts";

/**
 * Schlüssel-Bereich eines Limits: `ip` = HMAC-IP-Schlüssel, `guest` = guestId, `socket` = socket.id,
 * `player_question` = playerId + Frage-Instanz-ID (Idempotenz).
 */
export const RATE_LIMIT_SCOPES = ["ip", "guest", "socket", "player_question"] as const;
export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

export const RATE_LIMIT_STORES = ["memory", "mongo"] as const;
export type RateLimitStore = (typeof RATE_LIMIT_STORES)[number];

/** Ziele außerhalb der Event-Registry und der HTTP-Endpunkte. */
export const SPECIAL_LIMIT_TARGETS = [
  /** Socket.IO-Handshake (vor dem Ticket geprüft). */
  "socket:handshake",
  /** Fallback für jedes Event eines Sockets, zusätzlich zu den Event-Limits. */
  "socket:any-event",
  /** Verstöße eines Sockets: Limit-Treffer, Validierungsfehler, unbekannte Events. */
  "socket:violation",
  /** Trennungen eines Gasts wegen Verstößen. */
  "guest:violation-disconnect",
] as const;
export type SpecialLimitTarget = (typeof SPECIAL_LIMIT_TARGETS)[number];

export type RateLimitTarget = ClientEventName | HttpEndpoint | SpecialLimitTarget;

/** Reaktion bei Überschreitung. */
export type RateLimitOnExceed =
  /** Ack mit Fehlercode (bei RATE_LIMITED mit `retryAfterMs` = msBeforeNext). */
  | { readonly action: "ack_error"; readonly code: Extract<ErrorCode, "RATE_LIMITED" | "ALREADY_ANSWERED"> }
  /** HTTP 429, mit `Retry-After`-Header in Sekunden, wenn `retryAfterHeader`. */
  | { readonly action: "http_error"; readonly status: 429; readonly retryAfterHeader: boolean }
  /** Handshake ablehnen (`connect_error` mit `data.code`). */
  | { readonly action: "reject_handshake"; readonly code: Extract<ErrorCode, "RATE_LIMITED"> }
  /** Socket trennen. */
  | { readonly action: "disconnect" }
  /** Gast sperren (`bans`, kind „guest“) für `banDurationSec`. */
  | { readonly action: "ban_guest"; readonly banDurationSec: number };

export interface RateLimitRule {
  /** Eindeutige ID; zugleich Basis des `keyPrefix` für rate-limiter-flexible. */
  readonly id: string;
  readonly target: RateLimitTarget;
  readonly scope: RateLimitScope;
  /** Erlaubte Punkte je Zeitfenster. */
  readonly points: number;
  /** Zeitfenster in Sekunden. */
  readonly durationSec: number;
  /** Sperrdauer nach Überschreitung in Sekunden (0 = keine zusätzliche Sperre). */
  readonly blockDurationSec: number;
  readonly store: RateLimitStore;
  /**
   * `attempt`: jeder Aufruf verbraucht einen Punkt (vor dem Handler). `failure`: nur fehlgeschlagene
   * Versuche verbrauchen Punkte; während einer Sperre werden trotzdem alle Versuche abgewiesen.
   */
  readonly consume: "attempt" | "failure";
  /**
   * `rate` = Zeitfenster-Limit über rate-limiter-flexible; `once` = Idempotenz, die die Spiellogik
   * selbst durchsetzt (z. B. eine Antwort pro Person und Frage) – kein Limiter nötig.
   */
  readonly kind: "rate" | "once";
  readonly onExceed: RateLimitOnExceed;
  /** Überschreitung zählt als Verstoß des Sockets (`socket:violation`). */
  readonly countsAsViolation: boolean;
  readonly note?: string;
}

const HOUR = 3_600;
const DAY = 24 * HOUR;

const RATE_LIMITED_ACK = { action: "ack_error", code: "RATE_LIMITED" } as const;
const HTTP_429 = { action: "http_error", status: 429, retryAfterHeader: true } as const;

type RuleInput = Omit<RateLimitRule, "blockDurationSec" | "store" | "consume" | "kind" | "countsAsViolation"> &
  Partial<Pick<RateLimitRule, "blockDurationSec" | "store" | "consume" | "kind" | "countsAsViolation">>;

function rule(input: RuleInput): RateLimitRule {
  return { blockDurationSec: 0, store: "memory", consume: "attempt", kind: "rate", countsAsViolation: false, ...input };
}

/** Limit für ein Socket-Event pro Socket (Memory, Ack `RATE_LIMITED`, zählt als Verstoß). */
function socketEventRule(id: string, target: ClientEventName, points: number, durationSec: number): RateLimitRule {
  return rule({
    id,
    target,
    scope: "socket",
    points,
    durationSec,
    onExceed: RATE_LIMITED_ACK,
    countsAsViolation: true,
  });
}

/** Die vollständige Tabelle aus docs/06. */
export const RATE_LIMITS: readonly RateLimitRule[] = [
  // --- HTTP (apps/web bzw. apps/realtime) ---
  rule({
    id: "http.session.ip",
    target: "POST /api/session",
    scope: "ip",
    points: 10,
    durationSec: 600,
    store: "mongo",
    onExceed: HTTP_429,
  }),
  rule({
    id: "http.ticket.guest",
    target: "POST /api/realtime/ticket",
    scope: "guest",
    points: 30,
    durationSec: 60,
    onExceed: HTTP_429,
  }),
  rule({
    id: "http.ticket.ip",
    target: "POST /api/realtime/ticket",
    scope: "ip",
    points: 300,
    durationSec: 60,
    onExceed: HTTP_429,
  }),
  rule({
    id: "http.categories.ip",
    target: "GET /api/categories",
    scope: "ip",
    points: 60,
    durationSec: 60,
    onExceed: HTTP_429,
    note: "CDN-Cache davor (s-maxage=300)",
  }),
  rule({
    id: "http.health.ip",
    target: "GET /api/health",
    scope: "ip",
    points: 60,
    durationSec: 60,
    onExceed: HTTP_429,
    note: "Antwort ohne Details (nur ok)",
  }),
  rule({
    id: "http.healthz.ip",
    target: "GET /healthz",
    scope: "ip",
    points: 60,
    durationSec: 60,
    onExceed: HTTP_429,
    note: "Realtime; Antwort ohne Details (nur ok)",
  }),
  rule({
    id: "http.metrics.ip",
    target: "GET /metrics",
    scope: "ip",
    points: 30,
    durationSec: 60,
    onExceed: HTTP_429,
    note: "Zusätzlich METRICS_TOKEN (sonst 401); öffentlich nicht geroutet",
  }),

  // --- Verbindungen ---
  rule({
    id: "socket.handshake.ip",
    target: "socket:handshake",
    scope: "ip",
    points: 60,
    durationSec: 60,
    onExceed: { action: "reject_handshake", code: "RATE_LIMITED" },
  }),

  // --- Client→Server-Events ---
  socketEventRule("event.time-sync.socket", "time:sync", 10, 10),
  rule({
    id: "event.lobby-create.guest.minute",
    target: "lobby:create",
    scope: "guest",
    points: 3,
    durationSec: 60,
    store: "mongo",
    onExceed: RATE_LIMITED_ACK,
    countsAsViolation: true,
  }),
  rule({
    id: "event.lobby-create.guest.day",
    target: "lobby:create",
    scope: "guest",
    points: 30,
    durationSec: DAY,
    store: "mongo",
    onExceed: RATE_LIMITED_ACK,
    countsAsViolation: true,
  }),
  rule({
    id: "event.lobby-create.ip.hour",
    target: "lobby:create",
    scope: "ip",
    points: 30,
    durationSec: HOUR,
    store: "mongo",
    onExceed: RATE_LIMITED_ACK,
    countsAsViolation: true,
  }),
  rule({
    id: "event.lobby-join.failed.ip",
    target: "lobby:join",
    scope: "ip",
    points: 20,
    durationSec: 5 * 60,
    blockDurationSec: 15 * 60,
    store: "mongo",
    consume: "failure",
    onExceed: RATE_LIMITED_ACK,
    countsAsViolation: true,
    note: "Fehlgeschlagene Beitritte (Code-Raten); 20 / 5 min → 15 min Sperre",
  }),
  socketEventRule("event.lobby-join.socket", "lobby:join", 10, 60),
  socketEventRule("event.lobby-resume.socket", "lobby:resume", 10, 60),
  socketEventRule("event.lobby-leave.socket", "lobby:leave", 10, 60),
  socketEventRule("event.lobby-update-settings.socket", "lobby:update-settings", 10, 10),
  socketEventRule("event.lobby-kick.socket", "lobby:kick", 10, 60),
  socketEventRule("event.lobby-start.socket", "lobby:start", 5, 60),
  socketEventRule("event.game-rematch.socket", "game:rematch", 5, 60),
  socketEventRule("event.dev-add-bot.socket", "dev:add-bot", 10, 60),
  rule({
    id: "event.game-answer.once",
    target: "game:answer",
    scope: "player_question",
    points: 1,
    durationSec: 60,
    kind: "once",
    onExceed: { action: "ack_error", code: "ALREADY_ANSWERED" },
    note: "Idempotent: eine Antwort pro Person und Frage – setzt die Engine durch",
  }),
  socketEventRule("event.game-answer.socket", "game:answer", 5, 1),
  socketEventRule("event.game-pick.socket", "game:pick", 5, 5),
  socketEventRule("event.game-review.socket", "game:review", 5, 60),
  rule({
    id: "event.question-rate.guest",
    target: "question:rate",
    scope: "guest",
    points: 60,
    durationSec: 600,
    onExceed: RATE_LIMITED_ACK,
    countsAsViolation: true,
  }),
  rule({
    id: "event.question-report.guest",
    target: "question:report",
    scope: "guest",
    points: 5,
    durationSec: 600,
    onExceed: RATE_LIMITED_ACK,
    countsAsViolation: true,
  }),

  // --- Fallback, Verstöße, Sperren ---
  rule({
    id: "socket.any-event",
    target: "socket:any-event",
    scope: "socket",
    points: 30,
    durationSec: 1,
    onExceed: RATE_LIMITED_ACK,
    countsAsViolation: true,
    note: "Jedes Event (Fallback): Event verwerfen und Verstoß zählen",
  }),
  rule({
    id: "socket.violations",
    target: "socket:violation",
    scope: "socket",
    points: 10,
    durationSec: 60,
    onExceed: { action: "disconnect" },
    note: "Verstöße = Limit-Treffer, Validierungsfehler, unbekannte Events",
  }),
  rule({
    id: "guest.violation-disconnects",
    target: "guest:violation-disconnect",
    scope: "guest",
    points: 3,
    durationSec: 600,
    store: "mongo",
    onExceed: { action: "ban_guest", banDurationSec: 15 * 60 },
    note: "Wiederholte Trennungen wegen Verstößen → Gast 15 min sperren (bans)",
  }),
];

/** Alle Regeln zu einem Ziel (Event, Endpunkt oder Sonderziel). */
export function rateLimitsFor(target: RateLimitTarget): readonly RateLimitRule[] {
  return RATE_LIMITS.filter((entry) => entry.target === target);
}

/** Optionen für `RateLimiterMemory`/`RateLimiterMongo` (rate-limiter-flexible). */
export interface RateLimiterOptions {
  keyPrefix: string;
  points: number;
  /** Sekunden. */
  duration: number;
  /** Sekunden (0 = keine Sperre). */
  blockDuration: number;
}

export function toRateLimiterOptions(entry: RateLimitRule): RateLimiterOptions {
  return {
    keyPrefix: `qm:${entry.id}`,
    points: entry.points,
    duration: entry.durationSec,
    blockDuration: entry.blockDurationSec,
  };
}

/** Grenze mit Fehlercode bei Überschreitung (für `satisfies`-Prüfungen der Tabellen unten). */
interface LimitWithCode {
  readonly onExceed: ErrorCode;
  readonly [key: string]: unknown;
}

/** Gleichzeitige Sockets (docs/06): pro Gast, pro IP-Schlüssel und global. */
export const CONNECTION_LIMITS = {
  perGuest: { max: 5, onExceed: "TOO_MANY_CONNECTIONS" },
  perIp: { max: 100, onExceed: "TOO_MANY_CONNECTIONS" },
  /** Globale Obergrenze aus der Env `MAX_CONNECTIONS` (Standard 20.000). */
  global: { env: "MAX_CONNECTIONS", defaultMax: 20_000, onExceed: "SERVER_BUSY" },
} as const satisfies Record<string, LimitWithCode>;

/** Globale Kontingente (docs/06). */
export const QUOTAS = {
  /** Live einstellbar über `appConfig.maxActiveLobbies`. */
  maxActiveLobbies: { appConfigKey: "maxActiveLobbies", defaultMax: 5_000, onExceed: "SERVER_BUSY" },
  maxPlayersPerLobby: { max: 8, onExceed: "LOBBY_FULL" },
  /** docs/06 legt keinen Code fest; `RATE_LIMITED` („Zu viele Versuche. Warte kurz.“) passt am besten. */
  maxActiveHostedLobbiesPerGuest: { max: 1, onExceed: "RATE_LIMITED" },
} as const satisfies Record<string, LimitWithCode>;

/** Lastabwurf (docs/06 §DDoS): neue Verbindungen/Lobbys ablehnen, laufende Spiele laufen weiter. */
export const LOAD_SHEDDING = {
  eventLoopDelayP99Ms: 200,
  onExceed: "SERVER_BUSY",
} as const satisfies LimitWithCode;
