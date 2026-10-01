/**
 * Env des Realtime-Prozesses (docs/02 §Konfiguration, ADR-022): dieselben Schlüssel, die
 * `realtimeProcessEnv()` aus `@quizmaster/shared/env` erzeugt, plus `RATE_LIMIT_MODE`. Die Feld-Schemas
 * stammen aus `sourceEnvSchema` (eine Quelle der Wahrheit); hier kommen Pflichtfelder, Defaults und die
 * Regeln hinzu, die der Realtime-Prozess selbst prüfen muss (fail-closed).
 *
 * Fehlermeldungen nennen nur Schlüssel und Regeln – nie Werte (Secrets, URI).
 */
import { sourceEnvSchema } from "@quizmaster/shared/env";
import { z } from "zod";

/** `relaxed` hebt alle Rate-Limits und Verbindungsgrenzen an (Lasttest, E2E) – nur in `*_test`-Datenbanken. */
export const RATE_LIMIT_MODES = ["normal", "relaxed"] as const;
export type RateLimitMode = (typeof RATE_LIMIT_MODES)[number];

/** Faktor für `RATE_LIMIT_MODE=relaxed` (docs/07: „Rate-Limits pro IP für Lasttest-Umgebung per Env anheben“). */
export const RELAXED_LIMIT_FACTOR = 100;

/**
 * Art der Datenbank laut Name: `*_dev` = Entwicklung, `*_test` = automatische Tests, sonst Produktion
 * (auch Staging). Steuert fail-closed-Regeln (TLS-Pflicht, Dev-Bots, Registry-Vollständigkeit).
 */
export type DatabaseKind = "production" | "development" | "test";

export function databaseKindOf(dbName: string): DatabaseKind {
  if (dbName.endsWith("_test")) return "test";
  if (dbName.endsWith("_dev")) return "development";
  return "production";
}

const shape = sourceEnvSchema.shape;

const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

/** Optionales Quellfeld → Pflichtfeld. */
function required<T>(schema: z.ZodType<T | undefined>) {
  return schema.transform((value, ctx): T => {
    if (value === undefined) {
      ctx.addIssue({ code: "custom", message: "fehlt" });
      return z.NEVER;
    }
    return value;
  });
}

/** Optionales Quellfeld → Default. */
function withDefault<T>(schema: z.ZodType<T | undefined>, fallback: T) {
  return schema.transform((value): T => value ?? fallback);
}

const hostSchema = z.preprocess(
  emptyToUndefined,
  z.union([z.ipv4(), z.ipv6(), z.literal("localhost")], { error: "IP-Adresse oder localhost erwartet" }).optional(),
);

const rateLimitModeSchema = z.preprocess(emptyToUndefined, z.enum(RATE_LIMIT_MODES).optional());

export const realtimeEnvSchema = z
  .object({
    HOST: withDefault(hostSchema, "127.0.0.1"),
    REALTIME_PORT: required(shape.REALTIME_PORT),
    APP_ORIGIN: required(shape.APP_ORIGIN),
    MONGODB_URI: shape.MONGODB_URI,
    MONGODB_DB: shape.MONGODB_DB,
    MONGODB_COLLECTION_PREFIX: shape.MONGODB_COLLECTION_PREFIX,
    REALTIME_TICKET_SECRET: shape.REALTIME_TICKET_SECRET,
    IP_HASH_SECRET: shape.IP_HASH_SECRET,
    METRICS_TOKEN: shape.METRICS_TOKEN,
    TRUSTED_IP_HEADER: shape.TRUSTED_IP_HEADER,
    GAME_TIMING: withDefault(shape.GAME_TIMING, "normal"),
    QUESTION_POOL: withDefault(shape.QUESTION_POOL, "all"),
    MAX_CONNECTIONS: withDefault(shape.MAX_CONNECTIONS, 20_000),
    DEV_BOTS_ENABLED: withDefault(shape.DEV_BOTS_ENABLED, false),
    LOG_LEVEL: withDefault(shape.LOG_LEVEL, "info"),
    RATE_LIMIT_MODE: withDefault(rateLimitModeSchema, "normal"),
  })
  .superRefine((env, ctx) => {
    const kind = databaseKindOf(env.MONGODB_DB);
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (env.MONGODB_COLLECTION_PREFIX !== undefined && kind !== "test") {
      issue("MONGODB_COLLECTION_PREFIX", "nur für *_test-Datenbanken erlaubt");
    }
    if (env.RATE_LIMIT_MODE === "relaxed" && kind !== "test") {
      issue("RATE_LIMIT_MODE", "relaxed ist nur mit einer *_test-Datenbank erlaubt");
    }
    const secrets = [env.REALTIME_TICKET_SECRET, env.IP_HASH_SECRET, env.METRICS_TOKEN];
    if (new Set(secrets).size !== secrets.length) {
      issue(
        "REALTIME_TICKET_SECRET",
        "REALTIME_TICKET_SECRET, IP_HASH_SECRET und METRICS_TOKEN müssen verschieden sein",
      );
    }
    if (kind === "production") {
      if (env.DEV_BOTS_ENABLED) issue("DEV_BOTS_ENABLED", "muss in Produktion false sein");
      if (env.GAME_TIMING !== "normal") issue("GAME_TIMING", "muss in Produktion normal sein");
      if (env.APP_ORIGIN.some((origin) => !origin.startsWith("https://"))) {
        issue("APP_ORIGIN", "muss in Produktion https:// verwenden");
      }
    }
  })
  .transform((env) => ({ ...env, databaseKind: databaseKindOf(env.MONGODB_DB) }));

export type RealtimeEnv = z.output<typeof realtimeEnvSchema>;
/** Rohe Env-Werte (Strings), wie sie `realtimeProcessEnv()` bzw. `process.env` liefern. */
export type RealtimeEnvInput = Partial<Record<keyof z.input<typeof realtimeEnvSchema>, string>>;

export type LoadEnvResult = { ok: true; env: RealtimeEnv } | { ok: false; problems: string[] };

/** Validiert die Env; Probleme als „SCHLÜSSEL: Regel“ ohne Werte. */
export function parseRealtimeEnv(source: Readonly<Record<string, string | undefined>>): LoadEnvResult {
  const parsed = realtimeEnvSchema.safeParse(source);
  if (parsed.success) return { ok: true, env: parsed.data };
  const problems = parsed.error.issues.map((entry) => {
    const key = entry.path.length > 0 ? String(entry.path[0]) : "(Env)";
    const raw = source[key];
    const missing = raw === undefined || raw.trim() === "";
    return `${key}: ${missing ? "fehlt" : entry.message}`;
  });
  return { ok: false, problems: [...new Set(problems)] };
}
