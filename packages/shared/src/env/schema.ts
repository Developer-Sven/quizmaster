import { z } from "zod";
import { mongoUriTransport } from "./mongo-uri.ts";

/** Umgebungen mit eigener Env-Datei im Repo-Root (.env.dev / .env.prod, ADR-022). */
export const ENV_TARGETS = ["dev", "prod"] as const;
export type EnvTarget = (typeof ENV_TARGETS)[number];

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());

const boolFlag = z.enum(["true", "false"]).transform((value) => value === "true");

const port = z.coerce.number().int().min(1024).max(65535);

const secret = z.string().min(32, "mindestens 32 Zeichen");

const hostname = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "ungültiger Hostname");

const databaseName = z.string().regex(/^[A-Za-z0-9_-]{1,63}$/, "ungültiger Datenbankname");

const mongoUri = z.string().regex(/^mongodb(\+srv)?:\/\/\S+$/, "muss mit mongodb:// oder mongodb+srv:// beginnen");

const httpOrigin = z
  .string()
  .regex(/^https?:\/\/[^/\s]+$/, "Origin ohne Pfad, z. B. https://quiz.example.com")
  .transform((value) => value.toLowerCase());

const originList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  )
  .pipe(z.array(httpOrigin).min(1));

const collectionPrefix = z.string().regex(/^[a-z0-9_]{1,24}$/, "nur a–z, 0–9, _ (max. 24)");

/**
 * Inhalt von .env.dev / .env.prod (Quelle). Aus diesen wenigen Eingaben werden alle
 * Laufzeitwerte je App abgeleitet (resolveEnv). Unbekannte Schlüssel sind erlaubt.
 */
export const sourceEnvSchema = z.object({
  QUIZMASTER_DOMAIN: optional(hostname),
  QUIZMASTER_PORT: optional(port),
  REALTIME_PORT: optional(port),
  TLS_CERT_FILE: optional(z.string().startsWith("/")),
  TLS_KEY_FILE: optional(z.string().startsWith("/")),
  APP_ORIGIN: optional(originList),
  REALTIME_URL: optional(httpOrigin),
  TRUSTED_IP_HEADER: optional(z.string().regex(/^[a-z0-9-]{1,64}$/, "Header-Name in Kleinbuchstaben")),
  SEARCH_INDEXING: optional(boolFlag),

  MONGODB_URI: mongoUri,
  MONGODB_DB: databaseName,
  TEST_MONGODB_DB: optional(databaseName),
  MONGODB_COLLECTION_PREFIX: optional(collectionPrefix),

  SESSION_SECRET: secret,
  REALTIME_TICKET_SECRET: secret,
  IP_HASH_SECRET: secret,
  METRICS_TOKEN: secret,
  BACKUP_PASSPHRASE: optional(secret),

  TURNSTILE_ENABLED: optional(boolFlag),
  TURNSTILE_SITE_KEY: optional(z.string().min(1)),
  TURNSTILE_SECRET_KEY: optional(z.string().min(1)),

  GAME_TIMING: optional(z.enum(["normal", "fast"])),
  QUESTION_POOL: optional(z.enum(["all", "approved"])),
  MAX_CONNECTIONS: optional(z.coerce.number().int().min(1).max(1_000_000)),
  DEV_BOTS_ENABLED: optional(boolFlag),
  LOG_LEVEL: optional(z.enum(LOG_LEVELS)),

  ALERT_WEBHOOK_URL: optional(z.string().regex(/^https:\/\/\S+$/, "https-URL erwartet")),
  MDB_MCP_CONNECTION_STRING: optional(mongoUri),
});

export type SourceEnv = z.infer<typeof sourceEnvSchema>;

/** Datenbank-Verbindung ohne geprüftes TLS zu einem entfernten Host (docs/04, docs/06: „TLS erzwingen“). */
function isInsecureDatabaseTransport(env: SourceEnv): boolean {
  const transport = mongoUriTransport(env.MONGODB_URI);
  return !transport.verified && !transport.loopbackOnly;
}

/** Regeln, die nur zusammen mit der Zielumgebung prüfbar sind (fail-closed für Produktion). */
export function checkSourceRules(env: SourceEnv, target: EnvTarget): string[] {
  const problems: string[] = [];
  const secrets = [env.SESSION_SECRET, env.REALTIME_TICKET_SECRET, env.IP_HASH_SECRET, env.METRICS_TOKEN];
  if (new Set(secrets).size !== secrets.length)
    problems.push("SECRETS_NOT_DISTINCT: Secrets müssen je Zweck verschieden sein");
  if (env.TURNSTILE_ENABLED && (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY)) {
    problems.push("TURNSTILE_KEYS_MISSING: TURNSTILE_ENABLED=true braucht TURNSTILE_SITE_KEY und TURNSTILE_SECRET_KEY");
  }
  if (env.REALTIME_PORT !== undefined && env.REALTIME_PORT === env.QUIZMASTER_PORT) {
    problems.push("PORT_CONFLICT: REALTIME_PORT muss sich von QUIZMASTER_PORT unterscheiden");
  }
  if (env.MONGODB_COLLECTION_PREFIX !== undefined && !env.MONGODB_DB.endsWith("_test")) {
    problems.push("PREFIX_OUTSIDE_TEST_DB: MONGODB_COLLECTION_PREFIX ist nur für *_test-Datenbanken erlaubt");
  }
  if (env.TEST_MONGODB_DB !== undefined && !env.TEST_MONGODB_DB.endsWith("_test")) {
    problems.push("TEST_DB_NAME: TEST_MONGODB_DB muss auf _test enden");
  }
  if (target === "dev" && !env.MONGODB_DB.endsWith("_dev") && !env.MONGODB_DB.endsWith("_test")) {
    problems.push("DB_NAME: Entwicklung nutzt nur *_dev- oder *_test-Datenbanken (MONGODB_DB)");
  }
  if (target === "prod") {
    if (isInsecureDatabaseTransport(env)) {
      problems.push(
        "MONGODB_TLS: Produktion verlangt TLS mit Zertifikatsprüfung zur Datenbank " +
          "(mongodb+srv:// oder tls=true in MONGODB_URI, ohne tlsInsecure/tlsAllowInvalid*)",
      );
    }
    if (!env.QUIZMASTER_DOMAIN) problems.push("DOMAIN_MISSING: QUIZMASTER_DOMAIN fehlt");
    if (env.APP_ORIGIN?.some((origin) => !origin.startsWith("https://"))) {
      problems.push("ORIGIN_NOT_HTTPS: APP_ORIGIN muss in Produktion https:// verwenden");
    }
    if (env.REALTIME_URL !== undefined && !env.REALTIME_URL.startsWith("https://")) {
      problems.push("REALTIME_URL_NOT_HTTPS: REALTIME_URL muss in Produktion https:// verwenden (oder leer bleiben)");
    }
    if (!env.QUIZMASTER_PORT) problems.push("PORT_MISSING: QUIZMASTER_PORT fehlt");
    if (!env.TLS_CERT_FILE || !env.TLS_KEY_FILE) problems.push("TLS_MISSING: TLS_CERT_FILE und TLS_KEY_FILE fehlen");
    if (!env.TRUSTED_IP_HEADER) problems.push("IP_HEADER_MISSING: TRUSTED_IP_HEADER muss in Produktion gesetzt sein");
    if (env.DEV_BOTS_ENABLED) problems.push("DEV_BOTS_IN_PROD: DEV_BOTS_ENABLED muss false sein");
    if (env.GAME_TIMING === "fast") problems.push("FAST_TIMING_IN_PROD: GAME_TIMING muss normal sein");
    if (env.MONGODB_COLLECTION_PREFIX !== undefined)
      problems.push("PREFIX_IN_PROD: MONGODB_COLLECTION_PREFIX ist in Produktion verboten");
    if (env.MONGODB_DB.endsWith("_test") || env.MONGODB_DB.endsWith("_dev")) {
      problems.push("DB_NAME: Produktion darf keine _dev/_test-Datenbank nutzen");
    }
    if (!env.BACKUP_PASSPHRASE) problems.push("BACKUP_PASSPHRASE_MISSING: BACKUP_PASSPHRASE fehlt");
  }
  return problems;
}

/** Warnungen: kein Abbruch, aber sichtbar (z. B. offene DoD-Punkte). */
export function sourceWarnings(env: SourceEnv, target: EnvTarget): string[] {
  const warnings: string[] = [];
  if (target === "dev" && isInsecureDatabaseTransport(env)) {
    warnings.push(
      "MONGODB_TLS_OFF: Datenbank-Verbindung ohne (geprüftes) TLS – Zugangsdaten und Daten gehen " +
        "unverschlüsselt übers Netz (tls=true bzw. mongodb+srv://, docs/04)",
    );
  }
  if (target === "prod" && !env.TURNSTILE_ENABLED) warnings.push("TURNSTILE_DISABLED: Bot-Schutz ist aus");
  if (target === "prod" && !env.ALERT_WEBHOOK_URL)
    warnings.push("ALERTS_DISABLED: ALERT_WEBHOOK_URL fehlt, Alarme gehen nur ins Log");
  return warnings;
}
