/**
 * Logging (docs/06 §Logging & Monitoring, docs/07 „Logging asynchron“): pino als JSON nach stdout, mit
 * Redaction als Sicherheitsnetz – Tickets, Cookies, Authorization, MONGODB_URI und Secrets werden entfernt,
 * `guestId` wird zu einem gekürzten Hash, IP-Felder werden nie ausgegeben. Eigener Code loggt ohnehin nur
 * Kurz-Hashes (`guestTag`) und nie Sockets, Handshakes oder Header.
 *
 * Sicherheitsereignisse (abgelehnte Handshakes, Limit-Treffer, Validierungsfehler, Verstöße) werden gezählt
 * und periodisch zusammengefasst geloggt – nicht jedes Einzelereignis (Log-Flut bei Angriffen).
 */
import { createHash } from "node:crypto";
import type { DbLogger } from "@quizmaster/db";
import pino, { type DestinationStream, type Level, type Logger } from "pino";

export type { Logger };
export type LogLevel = Level | "silent";

/** Kurz-Hash einer guestId für Logs (die guestId ist geheim, docs/06 Invariante 4). */
export function guestTag(guestId: string): string {
  return `g_${createHash("sha256").update(guestId).digest("hex").slice(0, 12)}`;
}

const REDACTED = "[redacted]";

/** Felder mit Geheimnissen (auf den ersten drei Ebenen). */
const SECRET_FIELDS = [
  "ticket",
  "cookie",
  "authorization",
  "secret",
  "password",
  "uri",
  "MONGODB_URI",
  "REALTIME_TICKET_SECRET",
  "IP_HASH_SECRET",
  "METRICS_TOKEN",
  "SESSION_SECRET",
];

/** Felder mit IP-Adressen (docs/06: IPs nie in Logs). */
const IP_FIELDS = ["ip", "remoteAddress", "remoteIp", "clientIp", "address"];

/** Header mit IP-Adressen oder Zugangsdaten (nur unter `headers`). */
const SENSITIVE_HEADERS = ["cookie", "authorization", "cf-connecting-ip", "x-forwarded-for", "x-real-ip", "forwarded"];

function atDepths(field: string): string[] {
  return [field, `*.${field}`, `*.*.${field}`];
}

export const REDACT_PATHS: readonly string[] = [
  ...[...SECRET_FIELDS, ...IP_FIELDS, "guestId"].flatMap(atDepths),
  ...SENSITIVE_HEADERS.flatMap((header) => [`headers["${header}"]`, `*.headers["${header}"]`]),
];

function censor(value: unknown, path: string[]): unknown {
  if (path.at(-1) === "guestId" && typeof value === "string") return guestTag(value);
  return REDACTED;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  /** Ziel (Standard: stdout, asynchron gepuffert – vor `process.exit` `flushSync()` aufrufen). */
  destination?: DestinationStream;
  /** Zusätzliche feste Felder. */
  base?: Record<string, unknown>;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { app: "quizmaster-realtime", pid: process.pid, ...options.base },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: [...REDACT_PATHS], censor },
      serializers: { err: pino.stdSerializers.err },
    },
    options.destination ?? pino.destination({ dest: 1, sync: false }),
  );
}

/** Logger ohne Ausgabe (Tests). */
export function createSilentLogger(): Logger {
  return pino({ level: "silent" });
}

/** Adapter für `@quizmaster/db` (Text-Meldungen ohne Zugangsdaten). */
export function toDbLogger(logger: Logger): DbLogger {
  return {
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
  };
}

/** Arten gezählter Sicherheitsereignisse. */
export const SECURITY_EVENT_KINDS = [
  "handshake_rejected",
  "limit_hit",
  "validation_failed",
  "violation",
  "violation_disconnect",
  "ban",
  "http_rejected",
] as const;
export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number];

export interface SecurityLog {
  /** Zählt ein Ereignis; `reason` stammt immer aus einer festen Liste (nie aus Client-Daten). */
  record(kind: SecurityEventKind, reason: string): void;
  /** Schreibt die Zusammenfassung seit dem letzten Flush (nur, wenn etwas passiert ist). */
  flush(): void;
  start(): void;
  stop(): void;
}

export const SECURITY_LOG_INTERVAL_MS = 60_000;

export function createSecurityLog(logger: Logger, intervalMs = SECURITY_LOG_INTERVAL_MS): SecurityLog {
  let counts = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const flush = () => {
    if (counts.size === 0) return;
    const summary: Record<string, Record<string, number>> = {};
    for (const [key, count] of counts) {
      const [kind = "", reason = ""] = key.split("|");
      summary[kind] ??= {};
      summary[kind][reason] = count;
    }
    counts = new Map();
    logger.warn({ security: summary, windowMs: intervalMs }, "Sicherheitsereignisse");
  };

  return {
    record(kind, reason) {
      const key = `${kind}|${reason}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    flush,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(flush, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      flush();
    },
  };
}
