/**
 * Server-Kontext der Web-API: Env, Logger, Datenbank, Rate-Limits, Turnstile, Health und Kategorien –
 * lazy beim ersten Request aufgebaut (nie beim Import/Build). Handler bekommen ihn als Parameter, Tests
 * bauen eigene Kontexte (`createServerContext`) mit Test-DB, gemocktem `fetch` und eigener Uhr.
 *
 * Der Kontext lebt pro Modul-Instanz (Next kann Route-Bundles getrennt laden); der MongoClient ist über
 * `createMongoClient` trotzdem einer pro Prozess.
 */
import type { MongoClient } from "mongodb";
import type { Logger } from "pino";
import { getWebEnv, type WebEnv } from "../../env";
import { type CategoryCatalog, createCategoryCatalog } from "./categories";
import { connectWebData, type WebData } from "./db";
import { createHealthProbe, type HealthProbe } from "./health";
import { getLogger, toDbLogger } from "./logger";
import { createWebRateLimiters, type WebRateLimiters } from "./rate-limit";
import { createTurnstileVerifier, hostnamesOf, type TurnstileVerifier } from "./turnstile";

export interface ServerContext {
  env: WebEnv;
  logger: Logger;
  data: WebData;
  limiters: WebRateLimiters;
  /** `null`, wenn kein Turnstile-Secret konfiguriert ist. */
  turnstile: TurnstileVerifier | null;
  health: HealthProbe;
  categories: CategoryCatalog;
  /** Uhr in ms (Tests: steuerbar). */
  now(): number;
}

export interface ServerContextOptions {
  /** Vorhandener MongoClient (Tests); sonst der Prozess-Client. */
  client?: MongoClient;
  logger?: Logger;
  /** fetch für Turnstile-Siteverify (Tests: gemockt). */
  fetch?: typeof fetch;
  now?: () => number;
}

export function createServerContext(env: WebEnv, options: ServerContextOptions = {}): ServerContext {
  const logger = options.logger ?? getLogger();
  const now = options.now ?? Date.now;
  const data = connectWebData(env, {
    ...(options.client === undefined ? {} : { client: options.client }),
    logger: toDbLogger(logger),
  });
  const secretKey = env.turnstile.secretKey;
  return {
    env,
    logger,
    data,
    limiters: createWebRateLimiters({
      db: data.db,
      collectionPrefix: env.collectionPrefix,
      mode: env.rateLimitMode,
      logger,
    }),
    turnstile:
      secretKey === undefined
        ? null
        : createTurnstileVerifier({
            secretKey,
            allowedHostnames: hostnamesOf(env.appOrigins),
            logger,
            now,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          }),
    health: createHealthProbe({ ping: () => data.client.db("admin").command({ ping: 1 }), logger, now }),
    categories: createCategoryCatalog(data.collections.categories, { logger, now }),
    now,
  };
}

let current: ServerContext | undefined;

/** Kontext des Prozesses/Bundles – beim ersten Aufruf aus `getWebEnv()` gebaut (wirft bei ungültiger Env). */
export function getServerContext(): ServerContext {
  current ??= createServerContext(getWebEnv());
  return current;
}
