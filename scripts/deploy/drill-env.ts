// Quell-Env für Drills des Deploy-Werkzeugs (README „Vor dem Go-live offen“ → Drill):
//
//   node scripts/deploy/drill-env.ts create <datei> [--web-port 7490] [--realtime-port 7491]
//   node scripts/deploy/drill-env.ts cleanup <datei>
//
// create: Datenbank wie bei den automatischen Tests (ADR-029, @quizmaster/db/testing: TEST_MONGODB_URI bzw.
//   MONGODB_URI + TEST_MONGODB_DB aus .env.dev, nur *_test) mit eigenem Collection-Präfix, frische Zufalls-Secrets,
//   Test-Ports (nie die aus .env.prod – das prüft der Deploy). Schreibt atomar mit 600 und überschreibt nie.
// cleanup: droppt die Collections des Präfixes (nur *_test, nur Test-Präfixe) und löscht die Datei – nach dem Drill,
//   wenn die Test-Apps beendet sind (sonst legt Realtime sie neu an; der Janitor räumt Reste nach 6 h ab).
//
// Ausgaben nennen Datei, Datenbankname, Präfix, Ports und Schlüsselnamen – nie die URI oder Secrets.
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createMongoClient } from "@quizmaster/db";
import { createTestPrefix, dropPrefixCollections, resolveTestConnection, testPrefixOf } from "@quizmaster/db/testing";
import { isTooPermissive, maskMongoUri, readEnvFile } from "@quizmaster/shared/env";
import { DRILL_REALTIME_PORT, DRILL_WEB_PORT, drillEnv } from "./lib/drill.ts";
import { serializeEnv, writePrivateFile } from "./lib/envfiles.ts";

const USAGE = `Aufruf:
  node scripts/deploy/drill-env.ts create <datei> [--web-port ${DRILL_WEB_PORT}] [--realtime-port ${DRILL_REALTIME_PORT}]
  node scripts/deploy/drill-env.ts cleanup <datei>`;

/** Werte, die nie in einer Ausgabe stehen dürfen (URI) – werden maskiert. */
const sensitive: string[] = [];

function redact(text: string): string {
  return sensitive.reduce((result, value) => result.replaceAll(value, maskMongoUri(value)), text);
}

class DrillError extends Error {}

function port(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d{4,5}$/.test(raw) || value < 1024 || value > 65_535) throw new DrillError(`${flag}: Port 1024–65535`);
  return value;
}

async function create(file: string, webPort: number, realtimePort: number): Promise<void> {
  if (existsSync(file)) throw new DrillError(`${file} existiert bereits – wird nie überschrieben`);
  const connection = await resolveTestConnection();
  sensitive.push(connection.uri);
  try {
    if (connection.source === "memory") {
      throw new DrillError(
        "keine Test-Datenbank (TEST_MONGODB_URI oder .env.dev) – ein MongoMemoryReplSet endete mit diesem Prozess",
      );
    }
    const prefix = createTestPrefix();
    const env = drillEnv({ uri: connection.uri, dbName: connection.dbName, prefix, webPort, realtimePort });
    writePrivateFile(
      file,
      serializeEnv(env, [
        "quizmaster – Drill-Env (scripts/deploy/drill-env.ts), nur für --test-env mit eigenem PM2_HOME",
        "Nach dem Drill: node scripts/deploy/drill-env.ts cleanup <datei>",
      ]),
    );
    console.info(`drill-env – ${file} (600) angelegt: Datenbank ${connection.dbName}, Präfix ${prefix}`);
    console.info(`drill-env – Web :${webPort}, Realtime :${realtimePort}, Schlüssel: ${Object.keys(env).join(", ")}`);
  } finally {
    await connection.release();
  }
}

async function cleanup(file: string): Promise<void> {
  if (!existsSync(file)) throw new DrillError(`${file} fehlt`);
  if (isTooPermissive(file)) throw new DrillError(`${file} ist für andere lesbar (600 erwartet)`);
  const env = readEnvFile(file);
  const uri = env.MONGODB_URI ?? "";
  const dbName = env.MONGODB_DB ?? "";
  const prefix = env.MONGODB_COLLECTION_PREFIX ?? "";
  if (uri !== "") sensitive.push(uri);
  if (uri === "" || !dbName.endsWith("_test") || testPrefixOf(prefix) !== prefix) {
    throw new DrillError(`${file} ist keine Drill-Env (MONGODB_URI, *_test-Datenbank und Test-Präfix nötig)`);
  }
  const client = createMongoClient(uri, { appName: "quizmaster-drill", maxPoolSize: 2, cache: false });
  try {
    await client.connect();
    const dropped = await dropPrefixCollections(client.db(dbName), prefix);
    console.info(`drill-env – ${dropped} Collection(s) mit Präfix ${prefix} in ${dbName} entfernt`);
  } finally {
    await client.close();
  }
  rmSync(file);
  console.info(`drill-env – ${file} gelöscht`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "web-port": { type: "string" },
      "realtime-port": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, target] = positionals;
  if (
    values.help ||
    target === undefined ||
    positionals.length !== 2 ||
    !["create", "cleanup"].includes(command ?? "")
  ) {
    console.info(USAGE);
    process.exitCode = values.help ? 0 : 2;
    return;
  }
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), target);
  if (command === "create") {
    await create(
      file,
      port(values["web-port"], DRILL_WEB_PORT, "--web-port"),
      port(values["realtime-port"], DRILL_REALTIME_PORT, "--realtime-port"),
    );
  } else {
    await cleanup(file);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`drill-env – FEHLER ${redact(message)}`);
  process.exitCode = error instanceof DrillError ? 1 : 3;
});
