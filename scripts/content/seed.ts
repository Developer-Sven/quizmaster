// pnpm content:seed [--dry-run] [--env dev|prod] [--db <name>] [--content-dir <pfad>] [--confirm-prod]
//                   [--allow-mass-retire] [--prefix <präfix>]
// Katalog (JSON) → MongoDB, idempotent (docs/04 §Seed & Migrationen, docs/08 §4, ADR-021). Verbindung aus
// .env.<env> (MONGODB_URI, MONGODB_DB); --db überschreibt den Datenbanknamen. Ausgaben: nur Zählungen und
// maskierte Hosts – nie Zugangsdaten.
import { existsSync } from "node:fs";
import {
  closeMongoClient,
  createMongoClient,
  describeClientHosts,
  describeError,
  MONGO_POOL_SIZES,
  runStartChecks,
  SeedAbortError,
} from "@quizmaster/db";
import { checkSourceRules, envFilePath, readEnvFile, sourceEnvSchema } from "@quizmaster/shared/env";
import { fail, parseCli } from "./lib/cli.ts";
import { DEFAULT_CONTENT_DIR, displayPath, REPO_ROOT, resolveCliPath } from "./lib/paths.ts";
import { assertProdConfirmed, type SeedEnv, SeedGuardError } from "./lib/seed-guard.ts";
import { assertSeedTarget, describeSeedRun, prepareSeed, runSeed } from "./lib/seed-runner.ts";

const USAGE =
  "pnpm content:seed [--dry-run] [--env dev|prod] [--db <name>] [--content-dir <pfad>] [--confirm-prod] " +
  "[--allow-mass-retire] [--prefix <präfix>]";
const { values, positionals } = parseCli(
  {
    "dry-run": { type: "boolean", default: false },
    env: { type: "string", default: "dev" },
    db: { type: "string" },
    "content-dir": { type: "string" },
    "confirm-prod": { type: "boolean", default: false },
    "allow-mass-retire": { type: "boolean", default: false },
    prefix: { type: "string" },
  },
  USAGE,
);
if (positionals.length > 0) fail(`Unerwartete Argumente: ${positionals.join(" ")}\nAufruf: ${USAGE}`, 2);
if (values.env !== "dev" && values.env !== "prod") fail(`--env muss dev oder prod sein\nAufruf: ${USAGE}`, 2);
const env: SeedEnv = values.env;
const dryRun = values["dry-run"];
const contentDir = values["content-dir"] === undefined ? DEFAULT_CONTENT_DIR : resolveCliPath(values["content-dir"]);
const log = (line: string) => console.info(`content:seed – ${line}`);
/** Zugangsdaten für die Fehlerausgabe (werden vor jeder Ausgabe ersetzt, nie selbst ausgegeben). */
let connectionUri: string | undefined;
const sanitize = (message: string) =>
  connectionUri === undefined ? message : message.replaceAll(connectionUri, "mongodb://***");

async function main(): Promise<void> {
  // 1. Alles, was ohne Verbindung prüfbar ist – vor dem Lesen der Env-Datei.
  assertProdConfirmed(env, values["confirm-prod"]);
  const prepared = prepareSeed({ env, contentDir, prefix: values.prefix }, values.db);

  // 2. Verbindung aus .env.<env> (ohne Werte auszugeben).
  const path = envFilePath(REPO_ROOT, env);
  if (!existsSync(path)) fail(`.env.${env} fehlt – anlegen mit: pnpm setup:env ${env}`);
  const parsed = sourceEnvSchema.safeParse(readEnvFile(path));
  if (!parsed.success) fail(`.env.${env} ist ungültig – Details: pnpm env:check ${env}`);
  const problems = checkSourceRules(parsed.data, env);
  if (problems.length > 0) fail(`.env.${env}: ${problems.join("; ")}`);
  const source = parsed.data;
  connectionUri = source.MONGODB_URI;
  const dbName = values.db ?? source.MONGODB_DB;
  const prefix = values.prefix ?? (dbName.endsWith("_test") ? source.MONGODB_COLLECTION_PREFIX : undefined);
  // Mit bekanntem Datenbanknamen erneut prüfen (Fixtures/Präfix/Name gegen Umgebung).
  assertSeedTarget(prepared, env, dbName, prefix);

  const client = createMongoClient(source.MONGODB_URI, {
    appName: `quizmaster-seed-${env}`,
    maxPoolSize: MONGO_POOL_SIZES.script,
    cache: false,
  });
  try {
    log(
      `Ziel ${describeClientHosts(client)} / ${dbName}${prefix ? ` (Präfix ${prefix})` : ""} · env ${env}` +
        (dryRun ? " · DRY-RUN" : ""),
    );
    log(`Content ${displayPath(contentDir)}`);
    const checks = await runStartChecks(client);
    log(`MongoDB ${checks.serverVersion}, ${checks.topology === "sharded" ? "Sharded Cluster" : "Replica Set"}`);
    const run = await runSeed(
      client.db(dbName),
      {
        env,
        contentDir,
        dryRun,
        allowMassRetire: values["allow-mass-retire"],
        pool: source.QUESTION_POOL ?? "all",
        ...(prefix === undefined ? {} : { prefix }),
        logger: {
          info: (message) => log(message),
          warn: (message) => console.warn(`content:seed – ${message}`),
          error: (message) => console.error(`content:seed – ${message}`),
        },
      },
      prepared,
    );
    for (const line of describeSeedRun(run)) log(line);
  } finally {
    await closeMongoClient(client);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof SeedGuardError || error instanceof SeedAbortError)
    fail(`content:seed – ${sanitize(error.message)}`);
  fail(`content:seed – Fehler: ${sanitize(describeError(error))}`);
}
