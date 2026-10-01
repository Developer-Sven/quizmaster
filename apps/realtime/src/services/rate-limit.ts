/**
 * Rate-Limits (docs/06 §Rate-Limits & Kontingente) mit `rate-limiter-flexible` auf Basis der Tabelle
 * `RATE_LIMITS` aus `@quizmaster/shared`:
 * - `store: "memory"` → `RateLimiterMemory` (Hot Path, Socket-Events).
 * - `store: "mongo"` → `RateLimiterMongo` in der Collection `rateLimits` (sicherheitsrelevante, verteilte
 *   Zähler: Lobby-Erstellung, Fehlversuche, Verstoß-Trennungen) mit einem Memory-Limiter als Versicherung:
 *   Fehler oder Zeitüberschreitung des Stores (1,5 s) → Entscheidung aus dem Memory-Limiter, gezählt als
 *   Mongo-Fehler (`onStoreError`) – ein hängender Store hält so kein Event auf.
 *
 * `RATE_LIMIT_MODE=relaxed` (nur `*_test`-Datenbanken) multipliziert alle Punkte mit 100 (Lasttest/E2E).
 * Regeln mit `kind: "once"` (eine Antwort pro Person und Frage) setzt die Engine durch – hier kein Limiter.
 */
import {
  RATE_LIMITS,
  type RateLimitRule,
  type RateLimitTarget,
  rateLimitsFor,
  toRateLimiterOptions,
} from "@quizmaster/shared";
import type { Collection, Document, MongoClient } from "mongodb";
import { RateLimiterMemory, RateLimiterMongo, RateLimiterRes } from "rate-limiter-flexible";
import { type RateLimitMode, RELAXED_LIMIT_FACTOR } from "../env.ts";
import { withTimeout } from "../registry/util.ts";

/** Höchstwartezeit auf den Mongo-Store, danach entscheidet die Memory-Versicherung. */
export const STORE_TIMEOUT_MS = 1_500;

export interface RateLimitDecision {
  allowed: boolean;
  /** Frühester sinnvoller neuer Versuch in ms (0, wenn erlaubt). */
  retryAfterMs: number;
  consumedPoints: number;
  remainingPoints: number;
  /** true, wenn der Mongo-Store ausfiel und die Memory-Versicherung entschied. */
  degraded: boolean;
}

/** Mongo-Store der Zähler (Collection `rateLimits`, ggf. mit Test-Präfix). */
export interface RateLimitStore {
  client: MongoClient;
  dbName: string;
  collection: Collection<Document>;
}

export interface RateLimitServiceOptions {
  mode: RateLimitMode;
  /** Ohne Store laufen auch Mongo-Regeln im Speicher (Unit-Tests). */
  store?: RateLimitStore;
  /** Fehler/Timeout des Mongo-Stores (Metrik, Log). */
  onStoreError?: (rule: RateLimitRule, error: unknown) => void;
  storeTimeoutMs?: number;
}

export interface RateLimitService {
  readonly mode: RateLimitMode;
  /** Wirksame Regeln eines Ziels (relaxed: Punkte × 100). */
  rulesFor(target: RateLimitTarget): readonly RateLimitRule[];
  /** Wirksame Regel nach ID; wirft bei unbekannter ID. */
  rule(id: string): RateLimitRule;
  /** Verbraucht Punkte (Standard 1) für `key`. */
  consume(rule: RateLimitRule, key: string, points?: number): Promise<RateLimitDecision>;
  /** Prüft ohne Verbrauch, ob `key` gerade gesperrt ist (für `consume: "failure"`). */
  peek(rule: RateLimitRule, key: string): Promise<RateLimitDecision>;
  /** Setzt den Zähler eines Schlüssels zurück (Admin/Tests). */
  reset(rule: RateLimitRule, key: string): Promise<void>;
  /** Legt die Indizes der Collection `rateLimits` an (TTL auf `expire`, eindeutiger `key`). */
  ensureStore(): Promise<void>;
}

/** Wirksame Regel im Modus (nur `kind: "rate"` wird skaliert). */
export function effectiveRule(rule: RateLimitRule, mode: RateLimitMode): RateLimitRule {
  if (mode === "normal" || rule.kind !== "rate") return rule;
  return { ...rule, points: rule.points * RELAXED_LIMIT_FACTOR };
}

function allowed(res: RateLimiterRes | null, degraded: boolean): RateLimitDecision {
  return {
    allowed: true,
    retryAfterMs: 0,
    consumedPoints: res?.consumedPoints ?? 0,
    remainingPoints: res?.remainingPoints ?? 0,
    degraded,
  };
}

function blocked(res: RateLimiterRes, degraded: boolean): RateLimitDecision {
  return {
    allowed: false,
    retryAfterMs: Math.max(0, Math.ceil(res.msBeforeNext)),
    consumedPoints: res.consumedPoints,
    remainingPoints: 0,
    degraded,
  };
}

/** Ergebnis von `get`: gesperrt, solange mehr als `points` verbraucht sind und das Fenster läuft. */
function peekDecision(rule: RateLimitRule, res: RateLimiterRes | null, degraded: boolean): RateLimitDecision {
  if (res !== null && res.msBeforeNext > 0 && res.consumedPoints > rule.points) return blocked(res, degraded);
  return allowed(res, degraded);
}

interface LimiterEntry {
  rule: RateLimitRule;
  memory: RateLimiterMemory;
  mongo: RateLimiterMongo | null;
}

export function createRateLimitService(options: RateLimitServiceOptions): RateLimitService {
  const timeoutMs = options.storeTimeoutMs ?? STORE_TIMEOUT_MS;
  const rules = new Map(RATE_LIMITS.map((entry) => [entry.id, effectiveRule(entry, options.mode)]));
  const limiters = new Map<string, LimiterEntry>();

  const entryFor = (requested: RateLimitRule): LimiterEntry => {
    const cached = limiters.get(requested.id);
    if (cached !== undefined) return cached;
    const rule = rules.get(requested.id);
    if (rule === undefined) throw new Error(`Unbekannte Rate-Limit-Regel „${requested.id}“`);
    if (rule.kind !== "rate") throw new Error(`Regel „${rule.id}“ ist kein Zeitfenster-Limit (kind ${rule.kind})`);
    const limiterOptions = toRateLimiterOptions(rule);
    // Die Memory-Instanz ist bei Mongo-Regeln die Versicherung, sonst der Limiter selbst.
    const memory = new RateLimiterMemory(limiterOptions);
    const store = options.store;
    const mongo =
      rule.store === "mongo" && store !== undefined
        ? new RateLimiterMongo({
            ...limiterOptions,
            storeClient: store.client,
            dbName: store.dbName,
            tableName: store.collection.collectionName,
            disableIndexesCreation: true,
          })
        : null;
    const entry = { rule, memory, mongo };
    limiters.set(rule.id, entry);
    return entry;
  };

  const storeFailed = (rule: RateLimitRule, error: unknown) => {
    options.onStoreError?.(rule, error);
  };

  return {
    mode: options.mode,

    rulesFor(target) {
      return rateLimitsFor(target).map((entry) => rules.get(entry.id) ?? entry);
    },

    rule(id) {
      const rule = rules.get(id);
      if (rule === undefined) throw new Error(`Unbekannte Rate-Limit-Regel „${id}“`);
      return rule;
    },

    async consume(requested, key, points = 1) {
      const entry = entryFor(requested);
      if (entry.mongo !== null) {
        try {
          return allowed(await withTimeout(entry.mongo.consume(key, points), timeoutMs, "Rate-Limit-Store"), false);
        } catch (error) {
          if (error instanceof RateLimiterRes) return blocked(error, false);
          storeFailed(entry.rule, error);
        }
      }
      const degraded = entry.mongo !== null;
      try {
        return allowed(await entry.memory.consume(key, points), degraded);
      } catch (error) {
        if (error instanceof RateLimiterRes) return blocked(error, degraded);
        throw error;
      }
    },

    async peek(requested, key) {
      const entry = entryFor(requested);
      if (entry.mongo !== null) {
        try {
          return peekDecision(
            entry.rule,
            await withTimeout(entry.mongo.get(key), timeoutMs, "Rate-Limit-Store"),
            false,
          );
        } catch (error) {
          storeFailed(entry.rule, error);
        }
      }
      return peekDecision(entry.rule, await entry.memory.get(key), entry.mongo !== null);
    },

    async reset(requested, key) {
      const entry = entryFor(requested);
      await entry.memory.delete(key);
      if (entry.mongo !== null) await withTimeout(entry.mongo.delete(key), timeoutMs, "Rate-Limit-Store");
    },

    async ensureStore() {
      const store = options.store;
      if (store === undefined) return;
      // Gleiche Definitionen wie rate-limiter-flexible (createIndexes) – nur einmal zentral statt je Limiter.
      await store.collection.createIndex({ expire: -1 }, { expireAfterSeconds: 0 });
      await store.collection.createIndex({ key: 1 }, { unique: true });
    },
  };
}
