// pnpm stack:test [--web-port <port>] [--realtime-port <port>] [--no-build] [--log-dir <pfad>] [--log-level <level>]
//
// Vollständiger Test-Stack für E2E und manuelle Prüfungen (docs/11 §E2E, ADR-029):
//   1. Test-DB anlegen (`createTestDatabase`: quizmaster_test mit eigenem Collection-Präfix, in CI MongoMemoryReplSet)
//   2. Fixtures seeden (test/fixtures/content, gleicher Weg wie `pnpm content:seed`, inkl. Validierung)
//   3. Realtime (tsdown → dist/index.mjs) und Web (next build → NEXT_DIST_DIR=.next-e2e) bauen – außer mit --no-build
//   4. erst Realtime (`node dist/index.mjs`, bis /healthz antwortet), dann Web (`next start`, bis /api/health
//      antwortet) nur an 127.0.0.1 starten: Test-DB, GAME_TIMING=fast, DEV_BOTS_ENABLED=true,
//      RATE_LIMIT_MODE=relaxed, TURNSTILE_ENABLED=false, zufällige Test-Secrets
//   5. URLs ausgeben und laufen, bis SIGINT/SIGTERM/SIGHUP kommt (stirbt ein Server, endet der Stack mit Exit 1)
//   6. sauber beenden: Web und Realtime stoppen (SIGTERM → SIGKILL nach Frist), Test-Collections droppen
//
// Ausgaben enthalten nie Zugangsdaten oder Secrets; die Logs der Kindprozesse liegen im Log-Ordner.
// Playwright (e2e/playwright.config.ts) startet genau dieses Skript als `webServer`.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { FIXTURES_CONTENT_DIR } from "../content/lib/paths.ts";
import { prepareSeed, runSeed } from "../content/lib/seed-runner.ts";
import {
  isPortFree,
  killProcess,
  lowPriority,
  type ManagedProcess,
  startProcess,
  stopProcess,
  tailFile,
  waitForExit,
  waitForHealth,
} from "./lib/processes.ts";
import {
  buildEnv,
  createStackSecrets,
  NEXT_BIN,
  parseStackArgs,
  REALTIME_DIR,
  REALTIME_ENTRY,
  REPO_ROOT,
  realtimeStackEnv,
  redactSecrets,
  STACK_HOST,
  type StackOptions,
  stackUrls,
  USAGE,
  WEB_DIR,
  WEB_DIST_DIR,
  webStackEnv,
} from "./lib/stack-config.ts";

const REALTIME_READY_TIMEOUT_MS = 60_000;
const WEB_READY_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 15_000;
const LOG_TAIL_LINES = 40;

const log = (line: string) => console.info(`stack:test – ${line}`);
const warn = (line: string) => console.warn(`stack:test – ${line}`);

class StackError extends Error {
  readonly logPath: string | undefined;

  constructor(message: string, logPath?: string) {
    super(message);
    this.name = "StackError";
    this.logPath = logPath;
  }
}

const parsed = parseStackArgs(process.argv.slice(2), process.env.INIT_CWD ?? process.cwd());
if (!parsed.ok) {
  console.error(`${parsed.message}\n\nAufruf: ${USAGE}`);
  process.exit(2);
}
const options: StackOptions = parsed.options;
if (options.help) {
  console.info(`Aufruf: ${USAGE}`);
  process.exit(0);
}

const urls = stackUrls(options);
const processes: ManagedProcess[] = [];
/** Werte, die nie in einer Ausgabe auftauchen dürfen (URI, Secrets). */
const sensitive: string[] = [];
let database: TestDatabase | undefined;
let stopping: Promise<void> | undefined;
let signals = 0;

const seconds = (ms: number) => `${(ms / 1_000).toFixed(1).replace(".", ",")} s`;

/** Letzte Zeilen eines Logs – ohne Secrets – für Fehlermeldungen. */
function logExcerpt(path: string | undefined): string {
  if (path === undefined) return "";
  const tail = redactSecrets(tailFile(path, LOG_TAIL_LINES), sensitive);
  return tail === "" ? "" : `\n--- ${path} (Ende) ---\n${tail}\n---`;
}

async function runBuild(name: string, filter: string): Promise<void> {
  const logPath = join(options.logDir, `${name}-build.log`);
  const started = Date.now();
  const { command, args } = lowPriority("pnpm", ["--filter", filter, "run", "build"]);
  const proc = startProcess({
    name: `${name}-build`,
    command,
    args,
    cwd: REPO_ROOT,
    env: buildEnv(process.env),
    logPath,
  });
  processes.push(proc);
  const code = await waitForExit(proc);
  processes.splice(processes.indexOf(proc), 1);
  if (stopping !== undefined) throw new StackError(`${name}-Build abgebrochen`);
  if (code !== 0) throw new StackError(`${name}-Build fehlgeschlagen (Exit ${code ?? "Signal"})`, logPath);
  log(`${name} gebaut (${seconds(Date.now() - started)})`);
}

function assertBuildsPresent(): void {
  if (!existsSync(REALTIME_ENTRY)) {
    throw new StackError("--no-build: apps/realtime/dist/index.mjs fehlt – einmal ohne --no-build starten");
  }
  if (!existsSync(join(WEB_DIR, WEB_DIST_DIR, "BUILD_ID"))) {
    throw new StackError(`--no-build: apps/web/${WEB_DIST_DIR} fehlt – einmal ohne --no-build starten`);
  }
}

async function assertPortsFree(): Promise<void> {
  for (const [label, port] of [
    ["Web", options.webPort],
    ["Realtime", options.realtimePort],
  ] as const) {
    if (!(await isPortFree(port, STACK_HOST))) {
      throw new StackError(
        `${label}-Port ${STACK_HOST}:${port} ist belegt (läuft noch ein Stack?) – anderen Port wählen`,
      );
    }
  }
}

async function waitReady(proc: ManagedProcess, url: string, timeoutMs: number): Promise<void> {
  const result = await waitForHealth({ url, timeoutMs, proc, aborted: () => stopping !== undefined });
  if (result === "ready") return;
  if (result === "aborted") throw new StackError(`Start von ${proc.name} abgebrochen`);
  const reason = result === "exited" ? "hat sich beendet" : `nicht bereit nach ${seconds(timeoutMs)}`;
  throw new StackError(`${proc.name} ${reason}`, proc.logPath);
}

async function start(): Promise<void> {
  mkdirSync(options.logDir, { recursive: true });
  for (const file of ["realtime.log", "web.log", "realtime-build.log", "web-build.log"]) {
    rmSync(join(options.logDir, file), { force: true });
  }
  await assertPortsFree();

  // 1. Test-DB
  database = await createTestDatabase({ appName: "quizmaster-stack-test" });
  sensitive.push(database.uri);
  log(`Test-DB ${database.dbName} · Präfix ${database.prefix} · Quelle ${database.source}`);
  if (stopping !== undefined) return;

  // 2. Fixtures (Validierung + Seed wie `pnpm content:seed`, Ziel nur *_test mit Präfix)
  const seedOptions = { env: "dev" as const, contentDir: FIXTURES_CONTENT_DIR, prefix: database.prefix };
  const prepared = prepareSeed(seedOptions, database.dbName);
  const seeded = await runSeed(database.db, { ...seedOptions, dryRun: false, allowMassRetire: false }, prepared);
  const after = seeded.result.after;
  log(
    `Fixtures geseedet: ${seeded.questions} Fragen, ${seeded.categories} Kategorien` +
      (after === undefined ? "" : ` (${after.playableCategories} spielbar)`),
  );
  if (stopping !== undefined) return;

  // 3. Builds (nacheinander – schont CPU und Speicher)
  if (options.build) {
    await runBuild("realtime", "@quizmaster/realtime");
    await runBuild("web", "@quizmaster/web");
  } else {
    assertBuildsPresent();
    log("--no-build: vorhandene Builds werden genutzt");
  }
  if (stopping !== undefined) return;

  // 4. Server mit zufälligen Test-Secrets (je Lauf neu, nur in der Env der Kindprozesse)
  const secrets = createStackSecrets();
  sensitive.push(...Object.values(secrets));
  const envInput = {
    parent: process.env,
    ports: options,
    database: { uri: database.uri, dbName: database.dbName, prefix: database.prefix },
    secrets,
    logLevel: options.logLevel,
  };
  // Erst Realtime, dann Web: Wer auf `/api/health` wartet (Playwright `webServer.url`), darf sich darauf
  // verlassen, dass auch Realtime schon Verbindungen annimmt.
  const started = Date.now();
  const realtime = startProcess({
    name: "realtime",
    command: process.execPath,
    args: [REALTIME_ENTRY],
    cwd: REALTIME_DIR,
    env: realtimeStackEnv(envInput),
    logPath: join(options.logDir, "realtime.log"),
  });
  processes.push(realtime);
  await waitReady(realtime, `${urls.realtime}/healthz`, REALTIME_READY_TIMEOUT_MS);
  watchUnexpectedExit(realtime);
  log(`Realtime bereit: ${urls.realtime}  (${seconds(Date.now() - started)})`);
  if (stopping !== undefined) return;

  const web = startProcess({
    name: "web",
    command: process.execPath,
    args: [NEXT_BIN, "start", "-H", STACK_HOST, "-p", String(options.webPort)],
    cwd: WEB_DIR,
    env: webStackEnv(envInput),
    logPath: join(options.logDir, "web.log"),
  });
  processes.push(web);
  await waitReady(web, `${urls.web}/api/health`, WEB_READY_TIMEOUT_MS);
  watchUnexpectedExit(web);
  log(`Web bereit:      ${urls.web}  (${seconds(Date.now() - started)})`);

  // 5. Bereit – laufen bis zum Signal
  log(`Logs: ${options.logDir}`);
  log("GAME_TIMING=fast · DEV_BOTS_ENABLED=true · RATE_LIMIT_MODE=relaxed · TURNSTILE_ENABLED=false");
  console.info(`STACK_READY web=${urls.web} realtime=${urls.realtime}`);
  log("Beenden mit Strg+C");
}

/** Ein Server stirbt unerwartet → alles beenden (Exit 1), damit Playwright bzw. der Mensch es merkt. */
function watchUnexpectedExit(proc: ManagedProcess): void {
  void proc.exited.then((code) => {
    if (stopping !== undefined) return;
    console.error(`stack:test – ${proc.name} hat sich unerwartet beendet (Exit ${code ?? "Signal"})`);
    console.error(logExcerpt(proc.logPath));
    void stop(1);
  });
}

/** Geordnetes Beenden: Kindprozesse stoppen, Test-Collections droppen, Prozess beenden. Idempotent. */
function stop(exitCode: number): Promise<void> {
  stopping ??= (async () => {
    let code = exitCode;
    const running = [...processes].reverse();
    if (running.length > 0) log("Beende …");
    const results = await Promise.all(
      running.map(async (proc) => [proc.name, await stopProcess(proc, STOP_TIMEOUT_MS)]),
    );
    for (const [name, result] of results) {
      if (result === "killed") warn(`${name} reagierte nicht auf SIGTERM – mit SIGKILL beendet`);
    }
    if (database !== undefined) {
      try {
        await database.cleanup();
        log(`Test-Collections mit Präfix ${database.prefix} entfernt`);
      } catch (error) {
        console.error(
          `stack:test – Aufräumen der Test-DB fehlgeschlagen (der Janitor entfernt Reste nach 6 h): ${redactSecrets(
            error instanceof Error ? error.message : String(error),
            sensitive,
          )}`,
        );
        code = code === 0 ? 1 : code;
      }
    }
    process.exit(code);
  })();
  return stopping;
}

function onSignal(signal: NodeJS.Signals): void {
  signals += 1;
  if (signals > 1) {
    warn(`${signal} erneut – Kindprozesse werden sofort beendet`);
    for (const proc of processes) killProcess(proc);
    return;
  }
  log(`${signal} empfangen`);
  void stop(0);
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
process.on("SIGHUP", onSignal);
process.on("uncaughtException", (error) => {
  console.error(`stack:test – unerwarteter Fehler: ${redactSecrets(error.message, sensitive)}`);
  void stop(1);
});
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`stack:test – unbehandelte Ablehnung: ${redactSecrets(message, sensitive)}`);
  void stop(1);
});

start().catch((error: unknown) => {
  if (stopping !== undefined) return;
  const message = redactSecrets(error instanceof Error ? error.message : String(error), sensitive);
  console.error(`stack:test – Start fehlgeschlagen: ${message}`);
  if (error instanceof StackError) console.error(logExcerpt(error.logPath));
  void stop(1);
});
