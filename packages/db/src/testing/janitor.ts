/**
 * Aufräumen in der Test-Datenbank: Collections eines Präfixes droppen (`cleanup()`) und verwaiste
 * Präfixe abgebrochener Läufe entfernen (Janitor, älter als 6 h). Fasst nur Collections mit
 * Test-Präfix an – nie andere Namen und nie `system.*`.
 */
import type { Db } from "mongodb";
import { isTestDatabaseName } from "../collections.ts";
import { hasMongoErrorCode, MONGO_ERROR_CODES } from "../errors.ts";
import { prefixRegex, testPrefixCreatedAt, testPrefixOf } from "./prefix.ts";

/** Präfixe, die älter sind, gelten als verwaist. */
export const STALE_PREFIX_AGE_MS = 6 * 60 * 60 * 1_000;

function assertTestDatabase(db: Db): void {
  if (!isTestDatabaseName(db.databaseName)) {
    throw new Error(`Aufräumen nur in *_test-Datenbanken erlaubt (Datenbank: ${db.databaseName})`);
  }
}

/** Droppt eine Collection; „existiert nicht (mehr)“ zählt als erledigt (parallele Aufräumer). */
async function dropIfExists(db: Db, name: string): Promise<boolean> {
  try {
    return await db.dropCollection(name);
  } catch (error) {
    if (hasMongoErrorCode(error, MONGO_ERROR_CODES.namespaceNotFound)) return false;
    throw error;
  }
}

/** Droppt alle Collections mit diesem Präfix. Liefert die Anzahl gedroppter Collections. */
export async function dropPrefixCollections(db: Db, prefix: string): Promise<number> {
  assertTestDatabase(db);
  if (testPrefixOf(prefix) !== prefix) throw new Error(`Kein Test-Präfix: „${prefix}“`);
  const names = await db.listCollections({ name: prefixRegex(prefix) }, { nameOnly: true }).toArray();
  let dropped = 0;
  for (const { name } of names) {
    if (await dropIfExists(db, name)) dropped += 1;
  }
  return dropped;
}

export interface JanitorResult {
  prefixes: string[];
  collections: number;
}

/** Entfernt alle Test-Präfixe, die älter als `maxAgeMs` (Standard 6 h) sind. */
export async function cleanupStalePrefixes(
  db: Db,
  options: { now?: Date; maxAgeMs?: number } = {},
): Promise<JanitorResult> {
  assertTestDatabase(db);
  const now = (options.now ?? new Date()).getTime();
  const maxAgeMs = options.maxAgeMs ?? STALE_PREFIX_AGE_MS;
  const all = await db.listCollections({}, { nameOnly: true }).toArray();
  const stale = new Set<string>();
  let collections = 0;
  for (const { name } of all) {
    const prefix = testPrefixOf(name);
    if (prefix === null) continue;
    const createdAt = testPrefixCreatedAt(prefix);
    if (createdAt === null || now - createdAt.getTime() <= maxAgeMs) continue;
    stale.add(prefix);
    if (await dropIfExists(db, name)) collections += 1;
  }
  return { prefixes: [...stale], collections };
}
