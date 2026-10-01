/**
 * Konfiguration des Test-Stacks (`pnpm stack:test`, docs/11 §E2E, ADR-029): Optionen, Ports/URLs, zufällige
 * Test-Secrets und die Prozess-Env von Realtime und Web. Reine Funktionen (unit-getestet). Die Datenbank-URI
 * und die Secrets landen nur in der Env der Kindprozesse – nie in einer Ausgabe (siehe `redactSecrets`).
 */
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Repo-Wurzel relativ zu dieser Datei (scripts/dev/lib → ../../..). */
export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const REALTIME_DIR = join(REPO_ROOT, "apps/realtime");
export const WEB_DIR = join(REPO_ROOT, "apps/web");
export const REALTIME_ENTRY = join(REALTIME_DIR, "dist/index.mjs");
export const NEXT_BIN = join(WEB_DIR, "node_modules/next/dist/bin/next");

/** Server lauschen nur lokal (Loopback). */
export const STACK_HOST = "127.0.0.1";
export const DEFAULT_WEB_PORT = 3200;
export const DEFAULT_REALTIME_PORT = 4200;
/** Eigenes Build-Verzeichnis des Web-Builds, damit parallele Next-Instanzen sich nicht stören (next.config.ts). */
export const WEB_DIST_DIR = ".next-e2e";

export const STACK_LOG_LEVELS = ["fatal", "error", "warn", "info", "debug"] as const;
export type StackLogLevel = (typeof STACK_LOG_LEVELS)[number];

export const USAGE =
  "pnpm stack:test [--web-port <port>] [--realtime-port <port>] [--no-build] [--log-dir <pfad>] " +
  "[--log-level fatal|error|warn|info|debug]";

export interface StackOptions {
  webPort: number;
  realtimePort: number;
  /** false = vorhandene Builds nutzen (`--no-build`) */
  build: boolean;
  /** Ordner für die Logs der Kindprozesse (Builds, Web, Realtime) */
  logDir: string;
  logLevel: StackLogLevel;
  help: boolean;
}

export type ParseResult = { ok: true; options: StackOptions } | { ok: false; message: string };

function parsePort(raw: string | undefined, fallback: number, flag: string): number | string {
  if (raw === undefined) return fallback;
  if (!/^\d{1,5}$/.test(raw)) return `${flag}: ganze Zahl erwartet`;
  const port = Number(raw);
  if (port < 1024 || port > 65_535) return `${flag}: Port zwischen 1024 und 65535 erwartet`;
  return port;
}

function isLogLevel(value: string): value is StackLogLevel {
  return (STACK_LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Liest die CLI-Argumente. Relative `--log-dir`-Pfade gelten ab `cwd` (bei `pnpm stack:test` die Repo-Wurzel);
 * Standard ist ein Ordner je Web-Port im Temp-Verzeichnis.
 */
export function parseStackArgs(args: readonly string[], cwd: string = process.cwd()): ParseResult {
  let values: {
    "web-port"?: string | undefined;
    "realtime-port"?: string | undefined;
    "no-build"?: boolean | undefined;
    "log-dir"?: string | undefined;
    "log-level"?: string | undefined;
    help?: boolean | undefined;
  };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        "web-port": { type: "string" },
        "realtime-port": { type: "string" },
        "no-build": { type: "boolean" },
        "log-dir": { type: "string" },
        "log-level": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const webPort = parsePort(values["web-port"], DEFAULT_WEB_PORT, "--web-port");
  if (typeof webPort === "string") return { ok: false, message: webPort };
  const realtimePort = parsePort(values["realtime-port"], DEFAULT_REALTIME_PORT, "--realtime-port");
  if (typeof realtimePort === "string") return { ok: false, message: realtimePort };
  if (webPort === realtimePort) return { ok: false, message: "--web-port und --realtime-port müssen verschieden sein" };
  const logLevel = values["log-level"] ?? "info";
  if (!isLogLevel(logLevel)) return { ok: false, message: `--log-level: ${STACK_LOG_LEVELS.join(", ")} erwartet` };
  const rawLogDir = values["log-dir"];
  const logDir =
    rawLogDir === undefined
      ? join(tmpdir(), "quizmaster-stack-test", String(webPort))
      : isAbsolute(rawLogDir)
        ? rawLogDir
        : resolve(cwd, rawLogDir);
  return {
    ok: true,
    options: {
      webPort,
      realtimePort,
      build: values["no-build"] !== true,
      logDir,
      logLevel,
      help: values.help === true,
    },
  };
}

export interface StackUrls {
  web: string;
  realtime: string;
}

export function stackUrls(ports: Pick<StackOptions, "webPort" | "realtimePort">): StackUrls {
  return {
    web: `http://${STACK_HOST}:${ports.webPort}`,
    realtime: `http://${STACK_HOST}:${ports.realtimePort}`,
  };
}

/** Verbindung zur Test-DB aus `createTestDatabase()` (`uri` enthält ggf. Zugangsdaten – nie ausgeben). */
export interface StackDatabase {
  uri: string;
  dbName: string;
  prefix: string;
}

export interface StackSecrets {
  session: string;
  realtimeTicket: string;
  ipHash: string;
  metrics: string;
}

/** Vier verschiedene Zufalls-Secrets je Lauf (32 Byte, base64url = 43 Zeichen ≥ 32 wie in den Env-Schemas). */
export function createStackSecrets(random: (size: number) => Buffer = randomBytes): StackSecrets {
  const next = () => random(32).toString("base64url");
  const secrets = { session: next(), realtimeTicket: next(), ipHash: next(), metrics: next() };
  if (new Set(Object.values(secrets)).size !== 4) throw new Error("Zufalls-Secrets nicht verschieden");
  return secrets;
}

/** Präfixe der Schlüssel, die Web/Realtime lesen – sie kommen nie aus der Eltern-Env (Shell, .env). */
const APP_ENV_PREFIXES = ["MONGODB_", "TEST_MONGODB_", "TURNSTILE_", "QUIZMASTER_", "REALTIME_", "MDB_MCP_"];
const APP_ENV_KEYS = new Set([
  "NODE_ENV",
  "PORT",
  "HOST",
  "HOSTNAME",
  "APP_ORIGIN",
  "SESSION_SECRET",
  "IP_HASH_SECRET",
  "METRICS_TOKEN",
  "TRUSTED_IP_HEADER",
  "SEARCH_INDEXING",
  "LOG_LEVEL",
  "RATE_LIMIT_MODE",
  "GAME_TIMING",
  "QUESTION_POOL",
  "MAX_CONNECTIONS",
  "DEV_BOTS_ENABLED",
  "BACKUP_PASSPHRASE",
  "ALERT_WEBHOOK_URL",
  "TLS_CERT_FILE",
  "TLS_KEY_FILE",
  "NEXT_DIST_DIR",
]);

function isAppEnvKey(key: string): boolean {
  return APP_ENV_KEYS.has(key) || APP_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Farbschalter (z. B. von Playwright gesetzt) – die Kinder schreiben in Logdateien, dort stören Farbcodes. */
const COLOR_KEYS = new Set(["FORCE_COLOR", "DEBUG_COLORS"]);

/**
 * Eltern-Env ohne App-Schlüssel (PATH, HOME, NODE_OPTIONS, XDG_* … bleiben). So gelangen weder Werte aus der
 * Shell noch Test-Zugangsdaten (`TEST_MONGODB_URI`) ungewollt in die Kindprozesse (Least Privilege).
 */
export function baseChildEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && !isAppEnvKey(key) && !COLOR_KEYS.has(key)) env[key] = value;
  }
  env.NEXT_TELEMETRY_DISABLED = "1";
  env.NO_COLOR = "1";
  return env;
}

/** Env der Builds: ohne App-Schlüssel, Web mit eigenem `NEXT_DIST_DIR`. */
export function buildEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return { ...baseChildEnv(parent), NEXT_DIST_DIR: WEB_DIST_DIR };
}

export interface ChildEnvInput {
  parent: Readonly<Record<string, string | undefined>>;
  ports: Pick<StackOptions, "webPort" | "realtimePort">;
  database: StackDatabase;
  secrets: StackSecrets;
  logLevel: StackLogLevel;
}

/**
 * Realtime (docs/05 §Timings `fast`, docs/11): Test-DB mit Präfix, `GAME_TIMING=fast`, Dev-Bots, gelockerte
 * Limits (`RATE_LIMIT_MODE=relaxed` – nur bei *_test erlaubt), APP_ORIGIN = Web-URL des Stacks.
 */
export function realtimeStackEnv(input: ChildEnvInput): Record<string, string> {
  const urls = stackUrls(input.ports);
  return {
    ...baseChildEnv(input.parent),
    NODE_ENV: "production",
    HOST: STACK_HOST,
    REALTIME_PORT: String(input.ports.realtimePort),
    APP_ORIGIN: urls.web,
    MONGODB_URI: input.database.uri,
    MONGODB_DB: input.database.dbName,
    MONGODB_COLLECTION_PREFIX: input.database.prefix,
    REALTIME_TICKET_SECRET: input.secrets.realtimeTicket,
    IP_HASH_SECRET: input.secrets.ipHash,
    METRICS_TOKEN: input.secrets.metrics,
    GAME_TIMING: "fast",
    QUESTION_POOL: "all",
    DEV_BOTS_ENABLED: "true",
    RATE_LIMIT_MODE: "relaxed",
    LOG_LEVEL: input.logLevel,
  };
}

/**
 * Web (`next start`, ADR-023: Realtime-URL zur Laufzeit): gleiche Test-DB, gleiches Ticket-/IP-Secret wie
 * Realtime, Turnstile aus, Dev-Bots an (Button „Bot hinzufügen“), gelockerte Limits, eigenes `NEXT_DIST_DIR`.
 */
export function webStackEnv(input: ChildEnvInput): Record<string, string> {
  const urls = stackUrls(input.ports);
  return {
    ...baseChildEnv(input.parent),
    NODE_ENV: "production",
    NEXT_DIST_DIR: WEB_DIST_DIR,
    PORT: String(input.ports.webPort),
    HOSTNAME: STACK_HOST,
    APP_ORIGIN: urls.web,
    REALTIME_URL: urls.realtime,
    MONGODB_URI: input.database.uri,
    MONGODB_DB: input.database.dbName,
    MONGODB_COLLECTION_PREFIX: input.database.prefix,
    SESSION_SECRET: input.secrets.session,
    REALTIME_TICKET_SECRET: input.secrets.realtimeTicket,
    IP_HASH_SECRET: input.secrets.ipHash,
    TURNSTILE_ENABLED: "false",
    SEARCH_INDEXING: "false",
    DEV_BOTS_ENABLED: "true",
    RATE_LIMIT_MODE: "relaxed",
    LOG_LEVEL: input.logLevel,
  };
}

/** Ersetzt Secrets und die Datenbank-URI in Texten (z. B. Log-Auszügen), bevor sie ausgegeben werden. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 8) result = result.replaceAll(secret, "***");
  }
  return result;
}
