/**
 * Strukturiertes Logging für apps/web (docs/06 §Logging): pino mit Redaction – Cookies, Authorization,
 * Tickets, Turnstile-Tokens, Secrets und `MONGODB_URI` werden ersetzt, IP-Adressen entfernt, `guestId`
 * nur als gekürzter Hash geloggt. Der Logger entsteht lazy (kein Env-Zugriff beim Import).
 */
import { createHash } from "node:crypto";
import type { DbLogger } from "@quizmaster/db";
import { LOG_LEVELS } from "@quizmaster/shared/env";
import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

const REDACTED = "[redacted]";

/** Schlüssel, deren Werte nie im Log landen (auf oberster Ebene, eine Ebene tiefer und in `headers`). */
const SECRET_KEYS = [
  "cookie",
  "set-cookie",
  "authorization",
  "ticket",
  "turnstileToken",
  "token",
  "secret",
  "MONGODB_URI",
  "mongodbUri",
  "uri",
  "sessionSecret",
  "realtimeTicketSecret",
  "ipHashSecret",
  "secretKey",
  "ip",
  "remoteip",
] as const;

/** Nur als gekürzter Hash (Korrelation ohne die geheime ID). */
const HASHED_KEYS = ["guestId"] as const;

/** Pfade im fast-redact-Format: `key`, `*.key`, `headers.key`, `*.headers.key` (Bindestrich-Keys in Klammern). */
function redactPaths(): string[] {
  const paths: string[] = [];
  for (const key of [...SECRET_KEYS, ...HASHED_KEYS]) {
    if (/^[A-Za-z_$][\w$]*$/.test(key)) {
      paths.push(key, `*.${key}`, `headers.${key}`, `*.headers.${key}`);
    } else {
      paths.push(`headers["${key}"]`, `*.headers["${key}"]`);
    }
  }
  return paths;
}

/** Gekürzter, nicht umkehrbarer Hash einer guestId für Logs („g:1a2b3c4d5e6f“). */
export function hashGuestId(guestId: string): string {
  return `g:${createHash("sha256").update(guestId).digest("hex").slice(0, 12)}`;
}

function censor(value: unknown, path: string[]): unknown {
  const key = path[path.length - 1];
  if (key !== undefined && (HASHED_KEYS as readonly string[]).includes(key) && typeof value === "string") {
    return hashGuestId(value);
  }
  return REDACTED;
}

export interface CreateLoggerOptions {
  level?: string;
  /** Ziel-Stream (Tests); Standard stdout. */
  destination?: DestinationStream;
}

function safeLevel(level: string | undefined): string {
  return level !== undefined && (LOG_LEVELS as readonly string[]).includes(level) ? level : "info";
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const config = {
    level: safeLevel(options.level),
    base: { app: "quizmaster-web" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: redactPaths(), censor },
  };
  return options.destination === undefined ? pino(config) : pino(config, options.destination);
}

const LOGGER_SYMBOL = Symbol.for("quizmaster.web.logger");

/** Prozess-Logger (Level aus `LOG_LEVEL`, ungültig/fehlend → info). */
export function getLogger(): Logger {
  const holder = globalThis as { [LOGGER_SYMBOL]?: Logger };
  holder[LOGGER_SYMBOL] ??= createLogger({ level: process.env.LOG_LEVEL });
  return holder[LOGGER_SYMBOL];
}

/** Adapter für `@quizmaster/db` (Start-Checks, Client-Fabrik): nur Text-Nachrichten. */
export function toDbLogger(logger: Logger): DbLogger {
  return {
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
  };
}
