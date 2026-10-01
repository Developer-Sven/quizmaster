/**
 * Prozess-Env von apps/web (docs/02 §Konfiguration, ADR-022, ADR-023) – zod-validiert und LAZY: beim Import
 * passiert nichts (der Build läuft ohne Env). `getWebEnv()` parst beim ersten Aufruf genau einmal und cacht
 * das Ergebnis. Schlüssel wie `webProcessEnv()` in `@quizmaster/shared/env`, dazu `RATE_LIMIT_MODE` (Tests)
 * und `DEV_BOTS_ENABLED` (Button „Bot hinzufügen“, nur Dev/Test – in Produktion fehlt der Schlüssel).
 *
 * SERVER-ONLY: enthält Secrets. Öffentliche Werte bekommen Client-Komponenten ausschließlich über
 * `getPublicRuntimeConfig()` (`lib/server/runtime-config.ts`).
 */
import { normalizeOrigin } from "@quizmaster/shared";
import { LOG_LEVELS } from "@quizmaster/shared/env";
import { z } from "zod";

export const RATE_LIMIT_MODES = ["normal", "relaxed"] as const;
export type RateLimitMode = (typeof RATE_LIMIT_MODES)[number];

export const NODE_ENVS = ["development", "production", "test"] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Alle Schlüssel, die apps/web liest (Least Privilege, `webProcessEnv`). */
export const WEB_ENV_KEYS = [
  "NODE_ENV",
  "PORT",
  "HOSTNAME",
  "APP_ORIGIN",
  "REALTIME_URL",
  "MONGODB_URI",
  "MONGODB_DB",
  "MONGODB_COLLECTION_PREFIX",
  "SESSION_SECRET",
  "REALTIME_TICKET_SECRET",
  "IP_HASH_SECRET",
  "TURNSTILE_ENABLED",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "TRUSTED_IP_HEADER",
  "SEARCH_INDEXING",
  "LOG_LEVEL",
  "RATE_LIMIT_MODE",
  "DEV_BOTS_ENABLED",
] as const;
export type WebEnvKey = (typeof WEB_ENV_KEYS)[number];

export type WebEnvSource = Partial<Record<WebEnvKey, string | undefined>>;

const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());

const boolFlag = z.enum(["true", "false"]).transform((value) => value === "true");

const secret = z.string().min(32, "mindestens 32 Zeichen");

/** Origin ohne Pfad (`scheme://host[:port]`), kanonisch (klein, ohne Standard-Port). */
const origin = z.string().transform((value, ctx) => {
  const normalized = normalizeOrigin(value);
  if (normalized === null) {
    ctx.addIssue({ code: "custom", message: "Origin ohne Pfad erwartet, z. B. https://quiz.example.com" });
    return z.NEVER;
  }
  return normalized;
});

const originList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== ""),
  )
  .pipe(z.array(origin).min(1, "mindestens eine Origin"));

const isTestDatabase = (name: string) => name.endsWith("_test");

/** `*_dev` (Entwicklung) oder `*_test` (automatische Tests) – alles andere gilt als Produktion (fail-closed). */
export function isDevOrTestDatabase(name: string): boolean {
  return name.endsWith("_dev") || isTestDatabase(name);
}

/**
 * Offizielle Turnstile-Test-Secrets von Cloudflare (immer gültig / immer ungültig / „bereits verwendet“).
 * Mit ihnen ist der Bot-Schutz wirkungslos (bzw. sperrt alle aus) – erlaubt nur mit *_dev/*_test-Datenbank.
 */
export const TURNSTILE_TEST_SECRET_KEYS: readonly string[] = [
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
];

/** Rohschema über `process.env` (unbekannte Schlüssel sind erlaubt und werden ignoriert). */
export const webEnvSchema = z
  .object({
    NODE_ENV: optional(z.enum(NODE_ENVS)),
    PORT: optional(z.coerce.number().int().min(1).max(65_535)),
    HOSTNAME: optional(z.string().max(253)),
    APP_ORIGIN: originList,
    /** "" oder nicht gesetzt = gleiche Origin (Produktion: /socket.io/* wird geroutet). */
    REALTIME_URL: optional(origin),
    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\/\S+$/, "muss mit mongodb:// oder mongodb+srv:// beginnen"),
    MONGODB_DB: z.string().regex(/^[A-Za-z0-9_-]{1,63}$/, "ungültiger Datenbankname"),
    MONGODB_COLLECTION_PREFIX: optional(z.string().regex(/^[a-z0-9_]{1,24}$/, "nur a–z, 0–9, _ (max. 24)")),
    SESSION_SECRET: secret,
    REALTIME_TICKET_SECRET: secret,
    IP_HASH_SECRET: secret,
    TURNSTILE_ENABLED: optional(boolFlag),
    TURNSTILE_SITE_KEY: optional(z.string().min(1).max(256)),
    TURNSTILE_SECRET_KEY: optional(z.string().min(1).max(256)),
    TRUSTED_IP_HEADER: optional(z.string().regex(/^[a-z0-9-]{1,64}$/, "Header-Name in Kleinbuchstaben")),
    SEARCH_INDEXING: optional(boolFlag),
    LOG_LEVEL: optional(z.enum(LOG_LEVELS)),
    RATE_LIMIT_MODE: optional(z.enum(RATE_LIMIT_MODES)),
    DEV_BOTS_ENABLED: optional(boolFlag),
  })
  .superRefine((env, ctx) => {
    if (env.MONGODB_COLLECTION_PREFIX !== undefined && !isTestDatabase(env.MONGODB_DB)) {
      ctx.addIssue({
        code: "custom",
        path: ["MONGODB_COLLECTION_PREFIX"],
        message: "nur für *_test-Datenbanken erlaubt (ADR-029)",
      });
    }
    if (env.RATE_LIMIT_MODE === "relaxed" && !isTestDatabase(env.MONGODB_DB)) {
      ctx.addIssue({
        code: "custom",
        path: ["RATE_LIMIT_MODE"],
        message: "relaxed ist nur mit einer *_test-Datenbank erlaubt",
      });
    }
    const secrets = [env.SESSION_SECRET, env.REALTIME_TICKET_SECRET, env.IP_HASH_SECRET];
    if (new Set(secrets).size !== secrets.length) {
      ctx.addIssue({ code: "custom", path: ["SESSION_SECRET"], message: "Secrets müssen je Zweck verschieden sein" });
    }
    if (env.TURNSTILE_ENABLED === true && (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY)) {
      ctx.addIssue({
        code: "custom",
        path: ["TURNSTILE_ENABLED"],
        message: "TURNSTILE_ENABLED=true braucht TURNSTILE_SITE_KEY und TURNSTILE_SECRET_KEY",
      });
    }
    const productionDatabase = !isDevOrTestDatabase(env.MONGODB_DB);
    if (
      productionDatabase &&
      env.TURNSTILE_SECRET_KEY !== undefined &&
      TURNSTILE_TEST_SECRET_KEYS.includes(env.TURNSTILE_SECRET_KEY)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["TURNSTILE_SECRET_KEY"],
        message: "Cloudflare-Testschlüssel nur mit *_dev- oder *_test-Datenbank (sonst ist der Bot-Schutz wirkungslos)",
      });
    }
    if (productionDatabase && env.DEV_BOTS_ENABLED === true) {
      ctx.addIssue({
        code: "custom",
        path: ["DEV_BOTS_ENABLED"],
        message: "nur mit *_dev- oder *_test-Datenbank erlaubt (in Produktion false)",
      });
    }
  });

/** Validierte, aufbereitete Web-Env. */
export interface WebEnv {
  nodeEnv: NodeEnv;
  port: number | undefined;
  hostname: string | undefined;
  /** Erlaubte Origins (CSRF-Prüfung); die erste ist die kanonische öffentliche Origin. */
  appOrigins: readonly string[];
  appOrigin: string;
  /** true, wenn die kanonische Origin https ist: Secure-Cookie, HSTS, upgrade-insecure-requests. */
  httpsOrigin: boolean;
  /** "" = gleiche Origin. */
  realtimeUrl: string;
  mongodbUri: string;
  mongodbDb: string;
  collectionPrefix: string | undefined;
  sessionSecret: string;
  realtimeTicketSecret: string;
  ipHashSecret: string;
  turnstile: {
    /** Pflicht-Token beim Anlegen einer neuen Session. */
    enabled: boolean;
    siteKey: string | undefined;
    secretKey: string | undefined;
  };
  trustedIpHeader: string | undefined;
  searchIndexing: boolean;
  logLevel: LogLevel;
  rateLimitMode: RateLimitMode;
  /** Dev-Bots (`dev:add-bot`) anbieten – nur Dev/Test, Realtime registriert das Event nur mit demselben Schalter. */
  devBots: boolean;
}

/** Ungültige Env – `problems` nennt nur Schlüssel und Regel, nie Werte (Secrets!). */
export class WebEnvError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Ungültige Web-Env: ${problems.join("; ")}`);
    this.name = "WebEnvError";
    this.problems = problems;
  }
}

/** Parst eine Env-Quelle (z. B. `process.env`) – rein, ohne Cache. Wirft `WebEnvError`. */
export function parseWebEnv(source: WebEnvSource): WebEnv {
  const input: Record<string, string | undefined> = {};
  for (const key of WEB_ENV_KEYS) input[key] = source[key];
  const parsed = webEnvSchema.safeParse(input);
  if (!parsed.success) {
    throw new WebEnvError(
      parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "env"}: ${issue.message}`),
    );
  }
  const env = parsed.data;
  const [appOrigin = ""] = env.APP_ORIGIN;
  return {
    nodeEnv: env.NODE_ENV ?? "production",
    port: env.PORT,
    hostname: env.HOSTNAME,
    appOrigins: Object.freeze([...env.APP_ORIGIN]),
    appOrigin,
    httpsOrigin: appOrigin.startsWith("https://"),
    realtimeUrl: env.REALTIME_URL ?? "",
    mongodbUri: env.MONGODB_URI,
    mongodbDb: env.MONGODB_DB,
    collectionPrefix: env.MONGODB_COLLECTION_PREFIX,
    sessionSecret: env.SESSION_SECRET,
    realtimeTicketSecret: env.REALTIME_TICKET_SECRET,
    ipHashSecret: env.IP_HASH_SECRET,
    turnstile: {
      enabled: env.TURNSTILE_ENABLED ?? false,
      siteKey: env.TURNSTILE_SITE_KEY,
      secretKey: env.TURNSTILE_SECRET_KEY,
    },
    trustedIpHeader: env.TRUSTED_IP_HEADER,
    searchIndexing: env.SEARCH_INDEXING ?? false,
    logLevel: env.LOG_LEVEL ?? "info",
    rateLimitMode: env.RATE_LIMIT_MODE ?? "normal",
    devBots: env.DEV_BOTS_ENABLED ?? false,
  };
}

const CACHE_SYMBOL = Symbol.for("quizmaster.web.env");

type EnvHolder = { [CACHE_SYMBOL]?: WebEnv };

/**
 * Web-Env des Prozesses: beim ersten Aufruf aus `process.env` geparst, danach gecacht (auf `globalThis`,
 * damit Proxy- und Route-Bundles denselben Stand teilen). Fehler werden nicht gecacht.
 */
export function getWebEnv(): WebEnv {
  const holder = globalThis as EnvHolder;
  const cached = holder[CACHE_SYMBOL];
  if (cached !== undefined) return cached;
  const env = parseWebEnv(process.env);
  holder[CACHE_SYMBOL] = env;
  return env;
}

/** Nur für Tests: verwirft den Cache, damit der nächste `getWebEnv()`-Aufruf neu parst. */
export function clearWebEnvCache(): void {
  delete (globalThis as EnvHolder)[CACHE_SYMBOL];
}
