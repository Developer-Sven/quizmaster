/**
 * `@quizmaster/db/testing` – Test-Harness für Integrationstests (ADR-029). Jede Instanz arbeitet in
 * einer `*_test`-Datenbank unter einem eigenen Collection-Präfix; `cleanup()` räumt alles wieder ab.
 *
 * ```ts
 * import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
 * import { ensureIndexes, createRepositories } from "@quizmaster/db";
 *
 * let t: TestDatabase;
 * beforeAll(async () => {
 *   t = await createTestDatabase({ ensureIndexes: true });   // lokal: quizmaster_test auf dem Dev-Cluster
 * }, 60_000);
 * afterAll(() => t.cleanup());
 *
 * it("…", async () => {
 *   const repos = createRepositories(t.client, t.collections);
 *   await repos.guests.create(crypto.randomUUID(), new Date());
 * });
 * ```
 *
 * Apps/E2E: `t.uri`, `t.dbName` und `t.prefix` als `MONGODB_URI`, `MONGODB_DB` und
 * `MONGODB_COLLECTION_PREFIX` an den Kindprozess geben – `uri` nie loggen.
 */
import type { Db, MongoClient } from "mongodb";
import { createMongoClient } from "../client.ts";
import { type Collections, getCollections } from "../collections.ts";
import { type EnsureIndexesResult, ensureIndexes } from "../indexes.ts";
import { silentLogger } from "../logger.ts";
import { resolveTestConnection, type TestConnectionSource } from "./connection.ts";
import { cleanupStalePrefixes, dropPrefixCollections } from "./janitor.ts";
import { createTestPrefix, prefixRegex } from "./prefix.ts";

export {
  DEFAULT_MONGOMS_VERSION,
  DEFAULT_TEST_DB,
  resolveTestConnection,
  type TestConnection,
  type TestConnectionSource,
} from "./connection.ts";
export { cleanupStalePrefixes, dropPrefixCollections, type JanitorResult, STALE_PREFIX_AGE_MS } from "./janitor.ts";
export { createTestPrefix, prefixRegex, TEST_PREFIX_REGEX, testPrefixCreatedAt, testPrefixOf } from "./prefix.ts";

export interface TestDatabase {
  client: MongoClient;
  db: Db;
  /** Datenbankname (endet immer auf `_test`). */
  dbName: string;
  /** Verbindungs-URI (für Kindprozesse) – enthält ggf. Zugangsdaten: nie loggen. */
  uri: string;
  /** Eindeutiges Präfix dieses Harness, z. B. `t2609301812_ab12cd_`. */
  prefix: string;
  collections: Collections;
  source: TestConnectionSource;
  /** Ergebnis von `ensureIndexes()`, falls beim Anlegen angefordert. */
  indexes?: EnsureIndexesResult;
  /** Droppt alle Collections des Präfixes und schließt den Client (idempotent). */
  cleanup(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /** Direkt `ensureIndexes()` (inkl. Validator + appConfig) für das Präfix ausführen. */
  ensureIndexes?: boolean;
  /** appName des Test-Clients (Standard `quizmaster-test`). */
  appName?: string;
}

/** Janitor nur einmal je Prozess/Testdatei-Modul (listCollections auf der ganzen Test-DB). */
let janitorDone: Promise<unknown> | undefined;

export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const connection = await resolveTestConnection();
  const client = createMongoClient(connection.uri, {
    appName: options.appName ?? "quizmaster-test",
    maxPoolSize: 5,
    cache: false,
  });
  try {
    await client.connect();
    const db = client.db(connection.dbName);
    janitorDone ??= cleanupStalePrefixes(db).catch((error: unknown) => {
      janitorDone = undefined;
      throw error;
    });
    await janitorDone;

    let prefix = createTestPrefix();
    // Präfix-Kollision (extrem unwahrscheinlich) → neu ziehen.
    for (let attempt = 0; attempt < 5; attempt++) {
      const taken = await db.listCollections({ name: prefixRegex(prefix) }, { nameOnly: true }).toArray();
      if (taken.length === 0) break;
      prefix = createTestPrefix();
    }

    const collections = getCollections(db, { prefix });
    const indexes = options.ensureIndexes ? await ensureIndexes(db, { prefix, logger: silentLogger }) : undefined;
    let cleaned: Promise<void> | undefined;
    return {
      client,
      db,
      dbName: connection.dbName,
      uri: connection.uri,
      prefix,
      collections,
      source: connection.source,
      ...(indexes === undefined ? {} : { indexes }),
      cleanup() {
        cleaned ??= (async () => {
          try {
            await dropPrefixCollections(db, prefix);
          } finally {
            await client.close();
            await connection.release();
          }
        })();
        return cleaned;
      },
    };
  } catch (error) {
    await client.close();
    await connection.release();
    throw error;
  }
}
