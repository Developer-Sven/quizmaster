/**
 * MongoClient-Fabrik (docs/04 §Verbindung): EIN Client pro Prozess, feste Pool-Größen je App,
 * kurze Server-Auswahl-Frist. Der Client wird auf `globalThis` gecacht – so erzeugt Next.js-HMR im
 * Dev-Modus keine neuen Verbindungs-Pools. Die URI wird nur maskiert geloggt.
 */
import { createHash } from "node:crypto";
import { maskMongoUri } from "@quizmaster/shared/env";
import { MongoClient, type MongoClientOptions } from "mongodb";
import type { DbLogger } from "./logger.ts";

/** Pool-Größen je Prozess (docs/04, docs/07): web 10, realtime 20; Skripte klein. */
export const MONGO_POOL_SIZES = { web: 10, realtime: 20, script: 5 } as const;

/** Server-Auswahl-Frist: tote Datenbank fällt nach 5 s auf, statt Handler hängen zu lassen. */
export const SERVER_SELECTION_TIMEOUT_MS = 5_000;
/** Höchstens so lange auf eine freie Pool-Verbindung warten (Treiber-Standard wäre „ewig“). */
export const WAIT_QUEUE_TIMEOUT_MS = 10_000;

const MONGO_URI_REGEX = /^mongodb(\+srv)?:\/\/\S+$/;

export interface CreateMongoClientOptions {
  /** `quizmaster-web`, `quizmaster-realtime`, `quizmaster-seed` … (sichtbar in Server-Logs/currentOp). */
  appName: string;
  /** web 10 / realtime 20 (`MONGO_POOL_SIZES`). */
  maxPoolSize: number;
  /**
   * Standard `true`: ein Client pro Prozess und (appName, URI) – auf `globalThis` gecacht.
   * `false` nur für Tests/Werkzeuge, die bewusst einen eigenen Client brauchen.
   */
  cache?: boolean;
  /** Protokolliert das (maskierte) Ziel beim Anlegen. */
  logger?: DbLogger;
  /** Zusätzliche Treiber-Optionen, z. B. `readPreference: "secondaryPreferred"` für Skripte. */
  driverOptions?: Omit<MongoClientOptions, "appName" | "maxPoolSize">;
}

const CACHE_SYMBOL = Symbol.for("quizmaster.db.mongoClients");

type ClientCache = Map<string, MongoClient>;

function clientCache(): ClientCache {
  const holder = globalThis as { [CACHE_SYMBOL]?: ClientCache };
  holder[CACHE_SYMBOL] ??= new Map();
  return holder[CACHE_SYMBOL];
}

/** Cache-Schlüssel ohne Klartext-URI (enthält sonst das Passwort). */
function cacheKey(uri: string, appName: string): string {
  return `${appName}:${createHash("sha256").update(uri).digest("hex").slice(0, 24)}`;
}

/**
 * Liefert den Client des Prozesses für `appName` + URI (legt ihn beim ersten Aufruf an). Verbindet
 * noch nicht – das passiert beim ersten Kommando bzw. in `runStartChecks()`.
 */
export function createMongoClient(uri: string, options: CreateMongoClientOptions): MongoClient {
  if (!MONGO_URI_REGEX.test(uri)) {
    throw new Error("MONGODB_URI muss mit mongodb:// oder mongodb+srv:// beginnen");
  }
  if (!Number.isInteger(options.maxPoolSize) || options.maxPoolSize < 1) {
    throw new RangeError("maxPoolSize muss eine ganze Zahl ≥ 1 sein");
  }
  const useCache = options.cache !== false;
  const key = cacheKey(uri, options.appName);
  if (useCache) {
    const cached = clientCache().get(key);
    if (cached) return cached;
  }
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
    waitQueueTimeoutMS: WAIT_QUEUE_TIMEOUT_MS,
    ...options.driverOptions,
    appName: options.appName,
    maxPoolSize: options.maxPoolSize,
  });
  if (useCache) clientCache().set(key, client);
  options.logger?.info(
    `MongoDB-Client „${options.appName}“ → ${maskMongoUri(uri)} (Pool ${options.maxPoolSize}, Server-Auswahl ${
      options.driverOptions?.serverSelectionTimeoutMS ?? SERVER_SELECTION_TIMEOUT_MS
    } ms)`,
  );
  return client;
}

/** Schließt einen Client und entfernt ihn aus dem Prozess-Cache (Graceful Shutdown, Skript-Ende). */
export async function closeMongoClient(client: MongoClient): Promise<void> {
  const cache = clientCache();
  for (const [key, cached] of cache) {
    if (cached === client) cache.delete(key);
  }
  await client.close();
}

/** Maskierte Host-Liste eines Clients für Logs (ohne Zugangsdaten). */
export function describeClientHosts(client: MongoClient): string {
  const hosts = client.options.hosts.map((host) => host.toString()).join(",");
  const scheme = client.options.srvHost ? "mongodb+srv" : "mongodb";
  return maskMongoUri(`${scheme}://${client.options.srvHost ?? hosts}`);
}
