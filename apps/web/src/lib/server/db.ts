/**
 * MongoDB-Anbindung von apps/web (docs/04 §Verbindung): EIN Client pro Prozess (`createMongoClient` cacht
 * auf `globalThis` je appName + URI – auch über Next-HMR und getrennte Route-Bundles hinweg), appName
 * `quizmaster-web`, Pool 10. Web liest/schreibt nur guests, bans, categories und rateLimits.
 */
import {
  type Collections,
  createMongoClient,
  createRepositories,
  type DbLogger,
  getCollections,
  MONGO_POOL_SIZES,
  type Repositories,
} from "@quizmaster/db";
import type { Db, MongoClient } from "mongodb";
import type { WebEnv } from "../../env";

export const WEB_APP_NAME = "quizmaster-web";

export interface WebData {
  client: MongoClient;
  db: Db;
  collections: Collections;
  repos: Repositories;
}

/**
 * TLS-Ausnahme der Start-Checks: nur für *_dev- und *_test-Datenbanken (Dev-/Test-Cluster ohne TLS);
 * jede andere Datenbank verlangt geprüftes TLS (fail-closed). Bewusst NICHT an NODE_ENV gekoppelt –
 * `next start` setzt immer production.
 */
export function allowInsecureDatabaseTransport(dbName: string): boolean {
  return dbName.endsWith("_dev") || dbName.endsWith("_test");
}

export interface ConnectWebDataOptions {
  /** Vorhandener Client (Tests); sonst der Prozess-Client aus `createMongoClient`. */
  client?: MongoClient;
  logger?: DbLogger;
}

/** Collections + Repositories für die Env (verbindet noch nicht – das passiert beim ersten Kommando). */
export function connectWebData(
  env: Pick<WebEnv, "mongodbUri" | "mongodbDb" | "collectionPrefix">,
  options: ConnectWebDataOptions = {},
): WebData {
  const client =
    options.client ??
    createMongoClient(env.mongodbUri, {
      appName: WEB_APP_NAME,
      maxPoolSize: MONGO_POOL_SIZES.web,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  const db = client.db(env.mongodbDb);
  const collections = getCollections(db, env.collectionPrefix === undefined ? {} : { prefix: env.collectionPrefix });
  return { client, db, collections, repos: createRepositories(client, collections) };
}

const UNAVAILABLE_ERROR_NAMES = new Set([
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoTopologyClosedError",
  "MongoNotConnectedError",
  "MongoWaitQueueTimeoutError",
  "MongoOperationTimeoutError",
  "MongoPoolClearedError",
]);

/** MongoDB-Code 50 = MaxTimeMSExpired (Frist der Abfrage abgelaufen). */
const MAX_TIME_MS_EXPIRED = 50;

/** true, wenn die Datenbank (vorübergehend) nicht erreichbar/überlastet ist → 503 statt 500. */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (UNAVAILABLE_ERROR_NAMES.has(error.name)) return true;
  return (error as { code?: unknown }).code === MAX_TIME_MS_EXPIRED;
}
