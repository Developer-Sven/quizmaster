import type { EnvTarget, SourceEnv } from "./schema.ts";

/** Aus .env.<target> abgeleitete Laufzeitwerte (einzige Stelle für Ableitungen, ADR-022/024). */
export interface ResolvedEnv {
  target: EnvTarget;
  domain: string | undefined;
  webPort: number;
  realtimePort: number;
  /** Erlaubte Origins; die erste ist die kanonische öffentliche Origin. */
  appOrigins: string[];
  appOrigin: string;
  /** "" = gleiche Origin (Produktion: /socket.io/* wird geroutet). */
  realtimeUrl: string;
  source: SourceEnv;
}

export function resolveEnv(source: SourceEnv, target: EnvTarget): ResolvedEnv {
  const webPort = source.QUIZMASTER_PORT ?? (target === "prod" ? 7400 : 3000);
  const realtimePort = source.REALTIME_PORT ?? webPort + 1;
  const domain = source.QUIZMASTER_DOMAIN;
  const defaultOrigin = domain ? `https://${domain}` : `http://localhost:${webPort}`;
  const appOrigins = source.APP_ORIGIN ?? [defaultOrigin];
  const appOrigin = appOrigins[0] ?? defaultOrigin;
  const realtimeUrl = source.REALTIME_URL ?? (domain ? "" : `http://localhost:${realtimePort}`);
  return { target, domain, webPort, realtimePort, appOrigins, appOrigin, realtimeUrl, source };
}

type ProcessEnv = Record<string, string>;

function compact(entries: Record<string, string | number | boolean | undefined>): ProcessEnv {
  const out: ProcessEnv = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== "") out[key] = String(value);
  }
  return out;
}

const nodeEnv = (target: EnvTarget) => (target === "prod" ? "production" : "development");

/** Env für apps/web – nur die Schlüssel, die Web braucht (Least Privilege, docs/12 Secrets). */
export function webProcessEnv(env: ResolvedEnv): ProcessEnv {
  const s = env.source;
  return compact({
    NODE_ENV: nodeEnv(env.target),
    PORT: env.webPort,
    HOSTNAME: "127.0.0.1",
    APP_ORIGIN: env.appOrigins.join(","),
    REALTIME_URL: env.realtimeUrl,
    MONGODB_URI: s.MONGODB_URI,
    MONGODB_DB: s.MONGODB_DB,
    MONGODB_COLLECTION_PREFIX: s.MONGODB_COLLECTION_PREFIX,
    SESSION_SECRET: s.SESSION_SECRET,
    REALTIME_TICKET_SECRET: s.REALTIME_TICKET_SECRET,
    IP_HASH_SECRET: s.IP_HASH_SECRET,
    TURNSTILE_ENABLED: s.TURNSTILE_ENABLED ?? false,
    TURNSTILE_SITE_KEY: s.TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: s.TURNSTILE_SECRET_KEY,
    TRUSTED_IP_HEADER: s.TRUSTED_IP_HEADER,
    SEARCH_INDEXING: s.SEARCH_INDEXING ?? false,
    LOG_LEVEL: s.LOG_LEVEL ?? "info",
  });
}

/** Env für apps/realtime. */
export function realtimeProcessEnv(env: ResolvedEnv): ProcessEnv {
  const s = env.source;
  return compact({
    NODE_ENV: nodeEnv(env.target),
    HOST: "127.0.0.1",
    REALTIME_PORT: env.realtimePort,
    APP_ORIGIN: env.appOrigins.join(","),
    MONGODB_URI: s.MONGODB_URI,
    MONGODB_DB: s.MONGODB_DB,
    MONGODB_COLLECTION_PREFIX: s.MONGODB_COLLECTION_PREFIX,
    REALTIME_TICKET_SECRET: s.REALTIME_TICKET_SECRET,
    IP_HASH_SECRET: s.IP_HASH_SECRET,
    METRICS_TOKEN: s.METRICS_TOKEN,
    TRUSTED_IP_HEADER: s.TRUSTED_IP_HEADER,
    GAME_TIMING: s.GAME_TIMING ?? "normal",
    QUESTION_POOL: s.QUESTION_POOL ?? "all",
    MAX_CONNECTIONS: s.MAX_CONNECTIONS ?? 20_000,
    DEV_BOTS_ENABLED: s.DEV_BOTS_ENABLED ?? false,
    LOG_LEVEL: s.LOG_LEVEL ?? "info",
  });
}

/** Env für den Watchdog (liest nur Health/Metriken und meldet an den Webhook). */
export function watchdogProcessEnv(env: ResolvedEnv): ProcessEnv {
  const s = env.source;
  return compact({
    NODE_ENV: nodeEnv(env.target),
    WEB_HEALTH_URL: `http://127.0.0.1:${env.webPort}/api/health`,
    REALTIME_HEALTH_URL: `http://127.0.0.1:${env.realtimePort}/healthz`,
    REALTIME_METRICS_URL: `http://127.0.0.1:${env.realtimePort}/metrics`,
    METRICS_TOKEN: s.METRICS_TOKEN,
    ALERT_WEBHOOK_URL: s.ALERT_WEBHOOK_URL,
    APP_ORIGIN: env.appOrigin,
    LOG_LEVEL: s.LOG_LEVEL ?? "info",
  });
}
