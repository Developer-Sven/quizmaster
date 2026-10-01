/**
 * Rate-Limits der Web-API (docs/06 §Rate-Limits) exakt nach der Tabelle `RATE_LIMITS` aus
 * `@quizmaster/shared`: Memory für die einfachen Zähler, Mongo-Store (Collection `rateLimits`) für
 * sicherheitsrelevante Zähler (Session) mit Memory-`insuranceLimiter` und kurzer Frist – fällt die Datenbank
 * aus oder hängt, zählt die Versicherung weiter. `RATE_LIMIT_MODE=relaxed` (nur *_test-DB) multipliziert
 * die Punkte mit 100 (E2E/Lasttests, nie Produktion).
 */
import { collectionName } from "@quizmaster/db";
import {
  type HttpEndpoint,
  type RateLimitRule,
  type RateLimitScope,
  rateLimitsFor,
  toRateLimiterOptions,
} from "@quizmaster/shared";
import type { Db } from "mongodb";
import type { Logger } from "pino";
import { RateLimiterMemory, RateLimiterMongo, RLWrapperTimeouts } from "rate-limiter-flexible";
import type { RateLimitMode } from "../../env";

/** Web-Endpunkte mit Limit (die übrigen HTTP-Endpunkte gehören zu Realtime). */
export const WEB_ENDPOINTS = [
  "POST /api/session",
  "POST /api/realtime/ticket",
  "GET /api/categories",
  "GET /api/health",
] as const satisfies readonly HttpEndpoint[];
export type WebEndpoint = (typeof WEB_ENDPOINTS)[number];

export const RELAXED_RATE_LIMIT_FACTOR = 100;

/** Frist für den Mongo-Store; danach entscheidet der Memory-insuranceLimiter. */
export const MONGO_LIMITER_TIMEOUT_MS = 1_500;

export type RateLimitOutcome =
  | { ok: true }
  | { ok: false; reason: "limited"; retryAfterMs: number }
  /** Store und Versicherung ausgefallen → Aufrufer lehnt ab (fail-closed). */
  | { ok: false; reason: "unavailable" };

export interface WebRateLimiters {
  /** Verbraucht einen Punkt aller Regeln für Endpunkt + Schlüssel-Bereich. */
  consume(endpoint: WebEndpoint, scope: RateLimitScope, key: string): Promise<RateLimitOutcome>;
}

interface LimiterLike {
  consume(key: string, points?: number): Promise<unknown>;
}

interface LimiterEntry {
  rule: RateLimitRule;
  limiter: LimiterLike;
}

export interface CreateRateLimitersOptions {
  /** Datenbank für den Mongo-Store (Collection `rateLimits`, ggf. mit Test-Präfix). */
  db: Db;
  collectionPrefix?: string | undefined;
  mode: RateLimitMode;
  logger: Logger;
}

/** Ablehnung von rate-limiter-flexible (`RateLimiterRes`) – per Form erkannt, nicht per `instanceof`. */
function rejectionDelay(rejection: unknown): number | null {
  if (typeof rejection !== "object" || rejection === null) return null;
  const { msBeforeNext, consumedPoints } = rejection as { msBeforeNext?: unknown; consumedPoints?: unknown };
  return typeof msBeforeNext === "number" && typeof consumedPoints === "number" ? Math.max(0, msBeforeNext) : null;
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function createWebRateLimiters(options: CreateRateLimitersOptions): WebRateLimiters {
  const factor = options.mode === "relaxed" ? RELAXED_RATE_LIMIT_FACTOR : 1;
  const tableName = collectionName("rateLimits", options.collectionPrefix ?? "");
  const entries = new Map<string, LimiterEntry[]>();

  const build = (rule: RateLimitRule): LimiterLike => {
    const base = toRateLimiterOptions(rule);
    const limiterOptions = { ...base, points: base.points * factor };
    if (rule.store === "memory") return new RateLimiterMemory(limiterOptions);
    const insurance = new RateLimiterMemory(limiterOptions);
    const mongo = new RateLimiterMongo({
      ...limiterOptions,
      storeClient: options.db,
      tableName,
      insuranceLimiter: insurance,
    });
    return new RLWrapperTimeouts({ limiter: mongo, timeoutMs: MONGO_LIMITER_TIMEOUT_MS, insuranceLimiter: insurance });
  };

  for (const endpoint of WEB_ENDPOINTS) {
    for (const rule of rateLimitsFor(endpoint)) {
      if (rule.kind !== "rate") continue;
      const key = `${endpoint}|${rule.scope}`;
      entries.set(key, [...(entries.get(key) ?? []), { rule, limiter: build(rule) }]);
    }
  }

  return {
    async consume(endpoint, scope, key) {
      const list = entries.get(`${endpoint}|${scope}`);
      if (list === undefined || list.length === 0) {
        throw new Error(`Kein Rate-Limit für ${endpoint} (${scope}) definiert`);
      }
      let retryAfterMs: number | null = null;
      for (const { rule, limiter } of list) {
        try {
          await limiter.consume(key);
        } catch (rejection) {
          const delay = rejectionDelay(rejection);
          if (delay === null) {
            options.logger.error({ rule: rule.id, error: errorSummary(rejection) }, "Rate-Limiter nicht verfügbar");
            return { ok: false, reason: "unavailable" };
          }
          retryAfterMs = Math.max(retryAfterMs ?? 0, delay);
        }
      }
      return retryAfterMs === null ? { ok: true } : { ok: false, reason: "limited", retryAfterMs };
    },
  };
}
