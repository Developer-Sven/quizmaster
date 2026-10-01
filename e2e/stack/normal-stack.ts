// node e2e/stack/normal-stack.ts [--web-port 3201] [--realtime-port 4201] [--log-dir <pfad>] [--log-level warn]
//
// Zweiter Test-Stack für die E2E-Szenarien mit `GAME_TIMING=normal` (docs/11 Szenario 9 und 12, docs/09 §13):
// Phasen in Originallänge (Auflösung 3,5 s, Zug-Ergebnis 4 s, Rundentafel 6 s), damit axe, Layout-Prüfungen und
// Screenshots jede Phase sicher treffen und die Synchronität zweier Geräte bei echtem Timing messbar ist.
//
// Wie `pnpm stack:test --no-build` (scripts/dev/stack-test.ts, dessen Bausteine hier wiederverwendet werden):
// Test-DB mit eigenem Präfix (ADR-029), Fixtures seeden, vorhandene Builds (Realtime dist, Web NEXT_DIST_DIR
// .next-e2e) nur an 127.0.0.1 starten, zufällige Secrets je Lauf, beim Ende Server stoppen und Präfix droppen.
// Unterschiede: `GAME_TIMING=normal`, und jede Fixture-Frage wird als Langtext-Variante geseedet (140 Zeichen
// Frage, 40 Zeichen je Antwort – `long-texts.ts`), ohne die Dateien unter test/fixtures zu ändern.
// Playwright startet das Skript als zweiten `webServer` – erst nachdem der erste Stack gebaut hat.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { FIXTURES_CONTENT_DIR } from "../../scripts/content/lib/paths.ts";
import { type PreparedSeed, prepareSeed, runSeed } from "../../scripts/content/lib/seed-runner.ts";
import {
  isPortFree,
  killProcess,
  type ManagedProcess,
  startProcess,
  stopProcess,
  tailFile,
  waitForHealth,
} from "../../scripts/dev/lib/processes.ts";
import {
  createStackSecrets,
  NEXT_BIN,
  REALTIME_DIR,
  REALTIME_ENTRY,
  REPO_ROOT,
  realtimeStackEnv,
  redactSecrets,
  STACK_HOST,
  STACK_LOG_LEVELS,
  type StackLogLevel,
  stackUrls,
  WEB_DIR,
  WEB_DIST_DIR,
  webStackEnv,
} from "../../scripts/dev/lib/stack-config.ts";
import { longVariant } from "./long-texts.ts";

const READY_TIMEOUT_MS = { realtime: 60_000, web: 90_000 } as const;
const STOP_TIMEOUT_MS = 15_000;

const log = (line: string) => console.info(`normal-stack – ${line}`);

function parsePort(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!/^\d{4,5}$/.test(raw) || port < 1024 || port > 65_535) throw new Error(`${flag}: Port 1024–65535 erwartet`);
  return port;
}

function parseLogLevel(raw: string | undefined): StackLogLevel {
  const level = raw ?? "warn";
  const known = STACK_LOG_LEVELS.find((candidate) => candidate === level);
  if (known === undefined) throw new Error(`--log-level: ${STACK_LOG_LEVELS.join(", ")} erwartet`);
  return known;
}

const { values } = parseArgs({
  options: {
    "web-port": { type: "string" },
    "realtime-port": { type: "string" },
    "log-dir": { type: "string" },
    "log-level": { type: "string" },
  },
  allowPositionals: false,
  strict: true,
});
const ports = {
  webPort: parsePort(values["web-port"], 3201, "--web-port"),
  realtimePort: parsePort(values["realtime-port"], 4201, "--realtime-port"),
};
const logLevel = parseLogLevel(values["log-level"]);
const logDir = values["log-dir"] ?? join(REPO_ROOT, "e2e", "test-results", "stack-logs-normal");
const urls = stackUrls(ports);

const processes: ManagedProcess[] = [];
/** Werte, die nie in einer Ausgabe auftauchen dürfen (URI, Secrets). */
const sensitive: string[] = [];
let database: TestDatabase | undefined;
let stopping: Promise<void> | undefined;

function excerpt(path: string): string {
  const tail = redactSecrets(tailFile(path, 40), sensitive);
  return tail === "" ? "" : `\n--- ${path} (Ende) ---\n${tail}\n---`;
}

/** Fixtures laden, jede Frage durch ihre Langtext-Variante ersetzen (Kategorie und ID bleiben). */
function longTextSeed(prepared: PreparedSeed): PreparedSeed {
  const names = new Map(prepared.categoriesFile.categories.map((category) => [category.slug, category.name]));
  const questions = prepared.catalog.questions.map((question, index) => ({
    ...question,
    entry: longVariant(question.entry, names.get(question.category) ?? question.category, index + 1),
  }));
  return { ...prepared, catalog: { ...prepared.catalog, questions } };
}

async function waitReady(proc: ManagedProcess, url: string, timeoutMs: number): Promise<void> {
  const result = await waitForHealth({ url, timeoutMs, proc, aborted: () => stopping !== undefined });
  if (result !== "ready") throw new Error(`${proc.name} nicht bereit (${result})${excerpt(proc.logPath)}`);
}

function start(name: "realtime" | "web", args: string[], cwd: string, env: Record<string, string>): ManagedProcess {
  const proc = startProcess({ name, command: process.execPath, args, cwd, env, logPath: join(logDir, `${name}.log`) });
  processes.push(proc);
  void proc.exited.then((code) => {
    if (stopping !== undefined) return;
    console.error(
      `normal-stack – ${name} hat sich unerwartet beendet (Exit ${code ?? "Signal"})${excerpt(proc.logPath)}`,
    );
    void stop(1);
  });
  return proc;
}

async function main(): Promise<void> {
  mkdirSync(logDir, { recursive: true });
  for (const file of ["realtime.log", "web.log"]) rmSync(join(logDir, file), { force: true });
  for (const [label, port] of [
    ["Web", ports.webPort],
    ["Realtime", ports.realtimePort],
  ] as const) {
    if (!(await isPortFree(port, STACK_HOST))) throw new Error(`${label}-Port ${STACK_HOST}:${port} ist belegt`);
  }
  // Builds stammen vom ersten Stack (`pnpm stack:test`, Playwright startet ihn vorher und wartet auf ihn).
  if (!existsSync(REALTIME_ENTRY)) throw new Error("apps/realtime/dist/index.mjs fehlt – erst pnpm stack:test bauen");
  if (!existsSync(join(WEB_DIR, WEB_DIST_DIR, "BUILD_ID"))) {
    throw new Error(`apps/web/${WEB_DIST_DIR} fehlt – erst pnpm stack:test bauen`);
  }

  database = await createTestDatabase({ appName: "quizmaster-e2e-normal" });
  sensitive.push(database.uri);
  log(`Test-DB ${database.dbName} · Präfix ${database.prefix} · Quelle ${database.source}`);

  const seedOptions = { env: "dev" as const, contentDir: FIXTURES_CONTENT_DIR, prefix: database.prefix };
  const prepared = longTextSeed(prepareSeed(seedOptions, database.dbName));
  const seeded = await runSeed(database.db, { ...seedOptions, dryRun: false, allowMassRetire: false }, prepared);
  log(`Fixtures als Langtext-Variante geseedet: ${seeded.questions} Fragen, ${seeded.categories} Kategorien`);
  if (stopping !== undefined) return;

  const secrets = createStackSecrets();
  sensitive.push(...Object.values(secrets));
  const envInput = {
    parent: process.env,
    ports,
    database: { uri: database.uri, dbName: database.dbName, prefix: database.prefix },
    secrets,
    logLevel,
  };
  const realtime = start("realtime", [REALTIME_ENTRY], REALTIME_DIR, {
    ...realtimeStackEnv(envInput),
    GAME_TIMING: "normal",
  });
  await waitReady(realtime, `${urls.realtime}/healthz`, READY_TIMEOUT_MS.realtime);
  log(`Realtime bereit: ${urls.realtime} (GAME_TIMING=normal)`);
  const web = start(
    "web",
    [NEXT_BIN, "start", "-H", STACK_HOST, "-p", String(ports.webPort)],
    WEB_DIR,
    webStackEnv(envInput),
  );
  await waitReady(web, `${urls.web}/api/health`, READY_TIMEOUT_MS.web);
  log(`Web bereit: ${urls.web} · Logs: ${logDir}`);
  console.info(`STACK_READY web=${urls.web} realtime=${urls.realtime} timing=normal`);
}

/** Server stoppen, Test-Collections droppen, beenden. Idempotent. */
function stop(exitCode: number): Promise<void> {
  stopping ??= (async () => {
    let code = exitCode;
    await Promise.all([...processes].reverse().map((proc) => stopProcess(proc, STOP_TIMEOUT_MS)));
    if (database !== undefined) {
      try {
        await database.cleanup();
        log(`Test-Collections mit Präfix ${database.prefix} entfernt`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `normal-stack – Aufräumen fehlgeschlagen (Janitor räumt nach 6 h): ${redactSecrets(message, sensitive)}`,
        );
        code = code === 0 ? 1 : code;
      }
    }
    process.exit(code);
  })();
  return stopping;
}

let signals = 0;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    signals += 1;
    if (signals > 1) {
      // Zweites Signal: nicht mehr auf das geordnete Ende warten (wie stack-test.ts).
      log(`${signal} erneut – Server werden sofort beendet`);
      for (const proc of processes) killProcess(proc);
      process.exit(1);
    }
    log(`${signal} empfangen`);
    void stop(0);
  });
}
process.on("uncaughtException", (error) => {
  console.error(`normal-stack – unerwarteter Fehler: ${redactSecrets(error.message, sensitive)}`);
  void stop(1);
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`normal-stack – unbehandelte Ablehnung: ${redactSecrets(message, sensitive)}`);
  void stop(1);
});

main().catch((error: unknown) => {
  const message = redactSecrets(error instanceof Error ? error.message : String(error), sensitive);
  console.error(`normal-stack – Start fehlgeschlagen: ${message}`);
  void stop(1);
});
