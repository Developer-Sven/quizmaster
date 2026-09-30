/**
 * Verbindung des Test-Harness (ADR-029), in dieser Reihenfolge:
 * 1. `TEST_MONGODB_URI` (+ `TEST_MONGODB_DB`) aus `process.env`,
 * 2. `MONGODB_URI` + `TEST_MONGODB_DB` aus `<repo>/.env.dev` (lokal: Test-DB auf dem Dev-Cluster),
 * 3. sonst (CI ohne .env.dev) ein `MongoMemoryReplSet` (Version `MONGOMS_VERSION`, Standard 8.0.32).
 * Der Datenbankname MUSS auf `_test` enden. Zugangsdaten werden nie ausgegeben.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readEnvFile } from "@quizmaster/shared/env";
import { isTestDatabaseName } from "../collections.ts";

export const DEFAULT_TEST_DB = "quizmaster_test";
export const DEFAULT_MONGOMS_VERSION = "8.0.32";
/** Repo-Wurzel relativ zu dieser Datei (packages/db/src/testing → ../../../..). */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
export const DEV_ENV_FILE = resolve(REPO_ROOT, ".env.dev");

export type TestConnectionSource = "env" | "env-file" | "memory";

export interface TestConnection {
  /** Verbindungs-URI – enthält ggf. Zugangsdaten: nie loggen. */
  uri: string;
  dbName: string;
  source: TestConnectionSource;
  /** Gibt die Verbindung frei (stoppt beim letzten Nutzer den In-Memory-Server). */
  release(): Promise<void>;
}

const MONGO_URI_REGEX = /^mongodb(\+srv)?:\/\/\S+$/;

function assertTestDbName(dbName: string, origin: string): string {
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(dbName) || !isTestDatabaseName(dbName)) {
    throw new Error(`Test-Datenbank muss auf _test enden (${origin}: „${dbName}“) – Tests nie gegen dev/prod`);
  }
  return dbName;
}

function assertUri(uri: string, origin: string): string {
  if (!MONGO_URI_REGEX.test(uri)) throw new Error(`${origin}: keine gültige mongodb://- bzw. mongodb+srv://-URI`);
  return uri;
}

interface MemoryState {
  uri: string;
  refs: number;
  stop: () => Promise<unknown>;
}

let memory: Promise<MemoryState> | undefined;

async function startMemoryReplSet(): Promise<MemoryState> {
  const { MongoMemoryReplSet } = await import("mongodb-memory-server-core");
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
    binary: { version: process.env.MONGOMS_VERSION ?? DEFAULT_MONGOMS_VERSION },
  });
  return { uri: replSet.getUri(), refs: 0, stop: () => replSet.stop() };
}

async function acquireMemory(): Promise<TestConnection> {
  memory ??= startMemoryReplSet();
  let state: MemoryState;
  try {
    state = await memory;
  } catch (error) {
    memory = undefined;
    throw error;
  }
  state.refs += 1;
  let released = false;
  return {
    uri: state.uri,
    dbName: DEFAULT_TEST_DB,
    source: "memory",
    async release() {
      if (released) return;
      released = true;
      state.refs -= 1;
      if (state.refs === 0) {
        memory = undefined;
        await state.stop();
      }
    },
  };
}

const noRelease = async () => undefined;

/** Ermittelt die Test-Verbindung (siehe Reihenfolge oben). */
export async function resolveTestConnection(): Promise<TestConnection> {
  const envUri = process.env.TEST_MONGODB_URI;
  if (envUri !== undefined && envUri.trim() !== "") {
    return {
      uri: assertUri(envUri.trim(), "TEST_MONGODB_URI"),
      dbName: assertTestDbName(process.env.TEST_MONGODB_DB?.trim() || DEFAULT_TEST_DB, "TEST_MONGODB_DB"),
      source: "env",
      release: noRelease,
    };
  }
  if (existsSync(DEV_ENV_FILE)) {
    const env = readEnvFile(DEV_ENV_FILE);
    const uri = env.MONGODB_URI?.trim();
    if (!uri) throw new Error(".env.dev enthält kein MONGODB_URI (für Tests TEST_MONGODB_URI setzen)");
    return {
      uri: assertUri(uri, ".env.dev MONGODB_URI"),
      dbName: assertTestDbName(env.TEST_MONGODB_DB?.trim() || DEFAULT_TEST_DB, ".env.dev TEST_MONGODB_DB"),
      source: "env-file",
      release: noRelease,
    };
  }
  return acquireMemory();
}
