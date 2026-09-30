// Prüft einen Restore-Test und räumt ihn ab (Aufruf aus infra/ops/restore-test.sh):
//
//   node scripts/ops/restore-verify.ts --env-file .env.dev --db quizmaster_test --prefix rt261001023000_ \
//     --restore-log <mongorestore.log> [--manifest <quizmaster-….manifest.json>] [--keep]
//   node scripts/ops/restore-verify.ts --env-file .env.dev --db quizmaster_test --drop-stale
//   node scripts/ops/restore-verify.ts --env-file .env.dev --db quizmaster_test --prefix rt…_ --drop-only
//
// Vergleicht je Collection: Manifest (was mongodump ins Archiv schrieb) = mongorestore-Log (was aus dem Archiv
// gelesen wurde, 0 Fehler) = countDocuments in der Test-DB. Danach werden ALLE Collections mit dem Präfix
// gelöscht (auch wenn der Vergleich scheitert) – nur in einer *_test-Datenbank und nur mit einem Präfix der
// Form rt<12 Ziffern>_. `--drop-stale` entfernt Reste abgebrochener Läufe (älter als 24 h).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Db, MongoClient } from "mongodb";
import { loadEnv, OpsError } from "./lib/env.ts";
import { collectionOf, parseRestoreLog, RESTORE_PREFIX_PATTERN, restorePrefixDate } from "./lib/mongo-tools.ts";

const { values } = parseArgs({
  options: {
    "env-file": { type: "string" },
    db: { type: "string" },
    prefix: { type: "string" },
    "restore-log": { type: "string" },
    manifest: { type: "string" },
    keep: { type: "boolean", default: false },
    "drop-stale": { type: "boolean", default: false },
    "drop-only": { type: "boolean", default: false },
  },
});

interface Manifest {
  collections: Record<string, number>;
}

function expectedFromLog(logFile: string, db: string, prefix: string): Map<string, number> {
  const summary = parseRestoreLog(readFileSync(logFile, "utf8"));
  if (summary.collections.size === 0) throw new OpsError("mongorestore-Log enthält keine restaurierten Collections");
  if (summary.failed !== null && summary.failed > 0) {
    throw new OpsError(`mongorestore meldet ${summary.failed} fehlgeschlagene Dokumente`);
  }
  const expected = new Map<string, number>();
  for (const [namespace, result] of summary.collections) {
    const name = collectionOf(namespace, db);
    if (name === null || !name.startsWith(prefix)) {
      throw new OpsError(`unerwarteter Namespace im Restore-Log: ${namespace}`);
    }
    if (result.failures > 0) throw new OpsError(`${name}: ${result.failures} Dokumente nicht restauriert`);
    expected.set(name.slice(prefix.length), result.documents);
  }
  return expected;
}

function compare(label: string, left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): string[] {
  const problems: string[] = [];
  for (const name of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(name);
    const b = right.get(name);
    if (a !== b) problems.push(`${label}: ${name} ${a ?? "fehlt"} ≠ ${b ?? "fehlt"}`);
  }
  return problems;
}

async function collectionsWithPrefix(database: Db, prefix: string): Promise<string[]> {
  const entries = await database.listCollections({ name: { $regex: `^${prefix}` } }, { nameOnly: true }).toArray();
  return entries.map((entry) => entry.name).filter((name) => name.startsWith(prefix));
}

async function dropStale(database: Db): Promise<void> {
  const entries = await database.listCollections({ name: { $regex: "^rt[0-9]{12}_" } }, { nameOnly: true }).toArray();
  const limit = Date.now() - 24 * 60 * 60 * 1000;
  let dropped = 0;
  for (const { name } of entries) {
    const prefix = /^rt\d{12}_/.exec(name)?.[0];
    const created = prefix ? restorePrefixDate(prefix) : null;
    if (created && created.getTime() < limit) {
      await database.collection(name).drop();
      dropped += 1;
    }
  }
  console.log(`RESTORE_STALE_DROPPED=${dropped}`);
}

async function verifyAndDrop(database: Db, db: string, prefix: string): Promise<string[]> {
  const problems: string[] = [];
  try {
    if (!values["restore-log"]) throw new OpsError("--restore-log fehlt");
    const fromLog = expectedFromLog(values["restore-log"], db, prefix);
    const inDb = new Map<string, number>();
    for (const name of await collectionsWithPrefix(database, prefix)) {
      inDb.set(name.slice(prefix.length), await database.collection(name).countDocuments());
    }
    problems.push(...compare("Archiv/Test-DB", fromLog, inDb));
    if (values.manifest) {
      const manifest = JSON.parse(readFileSync(values.manifest, "utf8")) as Manifest;
      problems.push(...compare("Manifest/Archiv", new Map(Object.entries(manifest.collections)), fromLog));
    } else {
      console.log("restore-verify – Hinweis: kein Manifest zum Archiv, Vergleich nur Archiv ↔ Test-DB");
    }
    const total = [...inDb.values()].reduce((sum, count) => sum + count, 0);
    console.log(`RESTORE_COLLECTIONS=${inDb.size}`);
    console.log(`RESTORE_DOCUMENTS=${total}`);
  } finally {
    const restored = await collectionsWithPrefix(database, prefix);
    if (values.keep) {
      console.log(`restore-verify – --keep: ${restored.length} Collections mit Präfix ${prefix} bleiben liegen`);
    } else {
      for (const name of restored) await database.collection(name).drop();
      console.log(`RESTORE_DROPPED=${restored.length}`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const db = values.db ?? "";
  if (!values["env-file"]) throw new OpsError("--env-file fehlt");
  if (!db.endsWith("_test")) throw new OpsError("--db muss eine *_test-Datenbank sein");
  const prefix = values.prefix ?? "";
  if (!values["drop-stale"] && !RESTORE_PREFIX_PATTERN.test(prefix)) {
    throw new OpsError("--prefix muss die Form rt<12 Ziffern>_ haben");
  }
  const env = loadEnv(resolve(values["env-file"]));
  const client = new MongoClient(env.MONGODB_URI, {
    appName: "quizmaster-restore-test",
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 15_000,
  });
  try {
    await client.connect();
    const database = client.db(db);
    if (values["drop-stale"]) {
      await dropStale(database);
      return;
    }
    if (values["drop-only"]) {
      const restored = await collectionsWithPrefix(database, prefix);
      for (const name of restored) await database.collection(name).drop();
      console.log(`RESTORE_DROPPED=${restored.length}`);
      return;
    }
    const problems = await verifyAndDrop(database, db, prefix);
    if (problems.length > 0) throw new OpsError(`Abweichungen: ${problems.join("; ")}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof OpsError
      ? error.message
      : error instanceof Error
        ? `${error.name}: ${error.message.replace(/mongodb(\+srv)?:\/\/\S*/g, "mongodb://***")}`
        : String(error);
  console.error(`restore-verify – ${message}`);
  process.exit(1);
});
