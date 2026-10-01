// Deploy-Werkzeug für quizmaster auf diesem Server (ADR-024 pm2 + Host-Caddy, ADR-025 Releases).
//
//   pnpm deploy:prod [--sha <rev>] [--dry-run] [--skip-audit] [--skip-backup] [--rebuild]
//   pnpm deploy:rollback [--to <sha>] [--skip-backup]
//   pnpm deploy:restart [--apps web,realtime,watchdog]     Env aus .env.prod neu erzeugen + Apps neu starten
//   pnpm deploy:status
//
// Ablauf deploy:prod: Preflight (Werkzeuge, sauberer Arbeitsbaum außer bei --sha, env:check prod --connect,
// Ports, Platz, pm2-Daemon, Dienstbenutzer) → Build aus `git archive` in .deploy/build/<sha> → Audit-Gate →
// Env-Split je App → Datenbank-Sicherung, falls Schema-Dateien sich ändern (lib/db-backup.ts) → Rechte für den
// Dienstbenutzer (lib/access.ts) → current umhängen → web → Smoke → realtime → Smoke → watchdog → bei Fehler
// automatischer Rollback (Exit ≠ 0) → Sicherung von dump.pm2 + `pm2 save` (fremde Apps unverändert) → Kontrolle
// über Caddy → alte Releases bis auf 3 löschen. Ausgaben enthalten keine Secrets. SIGINT/SIGTERM/SIGHUP brechen
// nur vor der Aktivierung ab (lib/interrupt.ts).
//
// Dienstbenutzer (README „Systembenutzer“): Existiert `quizmaster`, laufen alle Apps mit dessen uid/gid
// (ecosystem.config.js) – der Smoke-Test prüft das je Prozess. Fehlt er, laufen sie als root (Warnung).
//
// Nur für Tests des Werkzeugs (verlangt ein eigenes PM2_HOME, nie den Haupt-Daemon; eigenes Layout .deploy/test,
// damit current, Env-Dateien und Releases der Produktion unberührt bleiben):
//   --test-env <datei>   eigene Quell-Env (Test-Ports, *_test-DB) statt .env.prod (drill-env.ts erzeugt eine)
//   --repo <verz>        anderes Git-Repository als Quelle für `git archive`
//   --simulate-failure <web|realtime|watchdog>   Smoke-Test dieser App schlägt absichtlich fehl
//   --test-user <name>   vorhandener Benutzer statt quizmaster (z. B. nobody; dessen Gruppe darf geteilt sein)
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statfsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  describeIdentity,
  describeStat,
  mongoUriFiles,
  prepareAccess,
  readProcStatus,
  removeTree,
  userLabel,
} from "./lib/access.ts";
import {
  ActivationError,
  activate,
  currentRelease,
  type DeployContext,
  type EnvProvider,
  envFromSource,
  KEEP_DUMP_BACKUPS,
  type PersistResult,
  persistProcessList,
} from "./lib/activate.ts";
import {
  auditGate,
  type BuildContext,
  buildRelease,
  cleanupBuild,
  listReleases,
  prepareSource,
  readReleaseMeta,
} from "./lib/build.ts";
import { backupReason, runDatabaseBackup, SCHEMA_PATHS } from "./lib/db-backup.ts";
import { readRelease } from "./lib/envfiles.ts";
import {
  changedPaths,
  commitSubject,
  dirtyPaths,
  extractArchive,
  OPERATIONAL_PATHS,
  resolveCommit,
} from "./lib/git.ts";
import { type Interrupts, installInterrupts } from "./lib/interrupt.ts";
import { APP_KEYS, APP_NAMES, APPS, type AppKey, envFile, type Layout, layoutFor, releaseDir } from "./lib/layout.ts";
import { acquireLock } from "./lib/lock.ts";
import { DeployError, describeError, info, ok, short, step, warn } from "./lib/log.ts";
import { checkSiteViaCaddy, listListeners } from "./lib/net.ts";
import { createPm2, daemonAlive, type Pm2Client, pm2Home } from "./lib/pm2.ts";
import { buildEnv, pm2Env, run, SYSTEM_PATH, which } from "./lib/proc.ts";
import { ensureRuntime } from "./lib/runtime.ts";
import { loadSource, type SourceContext } from "./lib/source-env.ts";
import {
  addHistory,
  currentOf,
  type DeployState,
  type HistoryEntry,
  pruneStack,
  pushActivation,
  readState,
  releasesToDelete,
  writeState,
} from "./lib/state.ts";
import { readServiceIdentity, SERVICE_USER, type ServiceIdentity } from "./service-user.cjs";

/** Build-Umgebung eines Releases: der Service Worker trägt die Release-Kennung (docs/10 „Update-Banner“). */
function releaseBuildEnv(sha: string): Record<string, string> {
  return { ...buildEnv(), SW_VERSION: sha.slice(0, 12) };
}

const ROOT = resolve(import.meta.dirname, "../..");
const KEEP_RELEASES = 3;
const MIN_FREE_BYTES = 3 * 1024 ** 3;
const DEFAULT_BACKUP_ROOT = "/root/backups/quizmaster";

const USAGE = `Aufruf:
  pnpm deploy:prod [--sha <rev>] [--dry-run] [--skip-audit] [--skip-backup] [--rebuild]
  pnpm deploy:rollback [--to <sha>] [--dry-run] [--skip-backup]
  pnpm deploy:restart [--apps web,realtime,watchdog] [--dry-run]
  pnpm deploy:status
Nur Tests (eigenes PM2_HOME, Layout .deploy/test): --test-env <datei> [--repo <verz>]
  [--simulate-failure web|realtime|watchdog] [--test-user <name>]`;

function parseCli() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        sha: { type: "string" },
        to: { type: "string" },
        apps: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "skip-audit": { type: "boolean", default: false },
        "skip-backup": { type: "boolean", default: false },
        rebuild: { type: "boolean", default: false },
        "test-env": { type: "string" },
        repo: { type: "string" },
        "simulate-failure": { type: "string" },
        "test-user": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    console.error(`deploy – ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exit(2);
  }
}

const { values, positionals } = parseCli();

type Command = "deploy" | "rollback" | "restart" | "status";
const command = positionals[0] as Command | undefined;

/** Abbruchsignale (SIGINT, SIGTERM, SIGHUP) – eingerichtet in main(). */
let interrupts: Interrupts | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

// ── Vorbedingungen ────────────────────────────────────────────────────────────

interface Tools {
  pm2: string;
  pnpm: string;
}

function guardTestMode(): string | null {
  const testEnv = values["test-env"];
  const testOnly = [values.repo, values["simulate-failure"], values["test-user"]];
  if (testOnly.some((value) => value !== undefined) && testEnv === undefined) {
    throw new DeployError("USAGE", "--repo, --simulate-failure und --test-user gibt es nur zusammen mit --test-env");
  }
  if (testEnv === undefined) return null;
  const home = process.env.PM2_HOME;
  if (!home)
    throw new DeployError("TEST_PM2_HOME", "Testmodus verlangt ein eigenes PM2_HOME (z. B. .tooling/pm2-test)");
  const main = join(homedir(), ".pm2");
  const same =
    resolve(home) === resolve(main) ||
    (existsSync(home) && existsSync(main) && realpathSync(home) === realpathSync(main));
  if (same) throw new DeployError("TEST_PM2_HOME", "Testmodus darf nie den Haupt-Daemon (~/.pm2) benutzen");
  const simulate = values["simulate-failure"];
  if (simulate !== undefined && !(APP_KEYS as readonly string[]).includes(simulate)) {
    throw new DeployError("USAGE", "--simulate-failure erwartet web, realtime oder watchdog");
  }
  return resolve(testEnv);
}

function checkTools(): Tools {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major !== 24)
    throw new DeployError("NODE_VERSION", `Node ${process.versions.node} – erwartet 24 (source .tooling/activate.sh)`);
  const missing: string[] = [];
  const find = (bin: string, pathValue?: string) => {
    const found = which(bin, pathValue) ?? which(bin, SYSTEM_PATH);
    if (!found) missing.push(bin);
    return found ?? bin;
  };
  for (const bin of ["git", "tar", "xz", "ss"]) find(bin, SYSTEM_PATH);
  const pm2 = find("pm2");
  const pnpm = find("pnpm");
  if (missing.length > 0) throw new DeployError("TOOLS_MISSING", `fehlende Werkzeuge: ${missing.join(", ")}`);
  ok("Werkzeuge: node 24, git, tar, xz, ss, pm2, pnpm");
  return { pm2, pnpm };
}

async function checkPnpmVersion(pnpm: string): Promise<void> {
  const result = await run(pnpm, ["--version"], { cwd: ROOT, env: buildEnv(), output: "capture", timeoutMs: 60_000 });
  const version = result.stdout.trim();
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { packageManager?: string };
  const wanted = /^pnpm@([^+]+)/.exec(manifest.packageManager ?? "")?.[1];
  if (result.code !== 0) throw new DeployError("PNPM", "pnpm --version fehlgeschlagen");
  if (wanted && version !== wanted) warn(`pnpm ${version}, packageManager verlangt ${wanted}`);
  else ok(`pnpm ${version}`);
}

async function checkWorktree(repo: string, explicitSha: boolean): Promise<void> {
  if (explicitSha) {
    info("Arbeitsbaum-Prüfung übersprungen (explizites --sha)");
    return;
  }
  const dirty = await dirtyPaths(repo);
  const operational = dirty.filter((path) => OPERATIONAL_PATHS.includes(path));
  const blocking = dirty.filter((path) => !OPERATIONAL_PATHS.includes(path));
  for (const path of operational) warn(`${path} wurde vom Betrieb aktualisiert – bitte committen`);
  if (blocking.length > 0) {
    const list = blocking.slice(0, 10).join(", ") + (blocking.length > 10 ? ` … (+${blocking.length - 10})` : "");
    throw new DeployError(
      "WORKTREE_DIRTY",
      `Arbeitsbaum nicht sauber (${list}). Committen oder bewusst einen Stand wählen: --sha <rev>`,
    );
  }
  ok("Arbeitsbaum sauber");
}

async function runEnvCheck(source: SourceContext): Promise<void> {
  if (source.mode === "test") {
    info(`Testmodus: ${source.label} nach Dev-Regeln geprüft, env:check prod übersprungen`);
    return;
  }
  const result = await run(process.execPath, [join(ROOT, "scripts", "env", "check.ts"), "prod", "--connect"], {
    cwd: ROOT,
    env: buildEnv(),
    output: "inherit",
    timeoutMs: 120_000,
  });
  if (result.code !== 0) throw new DeployError("ENV_CHECK", "pnpm env:check prod --connect meldet Fehler (siehe oben)");
}

async function checkPorts(pm2: Pm2Client | null, source: SourceContext): Promise<void> {
  const { webPort, realtimePort } = source.resolved;
  const listeners = await listListeners();
  const ours = new Set((pm2 ? await pm2.list(APP_NAMES) : []).map((app) => app.pid).filter((pid) => pid > 0));
  for (const port of [webPort, realtimePort]) {
    const holders = listeners.filter((listener) => listener.port === port);
    if (holders.length === 0) ok(`Port ${port} frei`);
    else if (holders.every((holder) => holder.pids.some((pid) => ours.has(pid)))) {
      ok(`Port ${port} von quizmaster belegt (wird neu gestartet)`);
    } else {
      const who = holders
        .map((holder) => `${holder.processName ?? "?"} PID ${holder.pids.join(",") || "?"}`)
        .join("; ");
      throw new DeployError("PORT_TAKEN", `Port ${port} ist von einem fremden Prozess belegt (${who})`);
    }
  }
}

function checkDisk(layout: Layout): void {
  const stats = statfsSync(layout.root);
  const free = stats.bavail * stats.bsize;
  const gib = (free / 1024 ** 3).toFixed(1);
  if (free < MIN_FREE_BYTES) throw new DeployError("DISK", `nur ${gib} GiB frei – mindestens 3 GiB nötig`);
  ok(`Plattenplatz: ${gib} GiB frei`);
}

function checkDaemon(home: string, mode: SourceContext["mode"]): void {
  if (daemonAlive(home)) {
    ok(`pm2-Daemon aktiv (${home})`);
    return;
  }
  if (mode === "prod") {
    throw new DeployError(
      "PM2_DAEMON",
      `kein laufender pm2-Daemon in ${home} – erst den Dienst prüfen (systemctl status pm2-root)`,
    );
  }
  info(`Testmodus: pm2-Daemon in ${home} wird bei Bedarf gestartet`);
}

/**
 * Benutzer der Apps – dieselbe Auflösung wie in ecosystem.config.js (scripts/deploy/service-user.cjs), im Testmodus
 * mit `--test-user` ein anderer vorhandener Benutzer. Jede Unstimmigkeit bricht ab, bevor etwas geändert wird.
 */
function resolveIdentity(): ServiceIdentity {
  const testUser = values["test-user"];
  try {
    return testUser === undefined
      ? readServiceIdentity({ user: SERVICE_USER, required: false, allowSharedGroup: false })
      : readServiceIdentity({ user: testUser, required: true, allowSharedGroup: true });
  } catch (error) {
    throw new DeployError(
      "SERVICE_USER",
      `${error instanceof Error ? error.message : String(error)} – README „Systembenutzer“`,
    );
  }
}

function checkIdentity(): ServiceIdentity {
  const identity = resolveIdentity();
  if (identity.kind === "root") {
    warn(
      `Dienstbenutzer ${identity.user} fehlt – web, realtime und watchdog laufen als root (Restrisiko). ` +
        "Einrichten: pnpm ops:create-user (als root), danach pnpm deploy:restart (README „Systembenutzer“)",
    );
    return identity;
  }
  ok(`Dienstbenutzer ${describeIdentity(identity)} – die Apps laufen ohne root-Rechte`);
  if (identity.sharedWith.length > 0) {
    warn(
      `Testmodus: Gruppe ${identity.group} ist nicht exklusiv (auch: ${identity.sharedWith.join(", ")}) – ` +
        "die Env-Dateien des Tests sind für diese Konten lesbar",
    );
  }
  if (!/\/(nologin|false)$/.test(identity.shell)) {
    warn(`${identity.user} hat die Login-Shell ${identity.shell} – erwartet nologin (infra/ops/create-user.sh)`);
  }
  return identity;
}

// ── gemeinsame Bausteine ──────────────────────────────────────────────────────

function createContext(layout: Layout, tools: Tools, source: SourceContext, identity: ServiceIdentity): DeployContext {
  const home = pm2Home();
  const backupRoot =
    source.mode === "test" ? join(home, "backups") : (process.env.QM_BACKUP_ROOT ?? DEFAULT_BACKUP_ROOT);
  const simulate = values["simulate-failure"] as AppKey | undefined;
  return {
    layout,
    pm2: createPm2({ bin: tools.pm2, env: pm2EnvFor(layout, source.mode), ecosystem: layout.ecosystem }),
    pm2Home: home,
    source,
    identity,
    backupRoot,
    simulateFailure: simulate ?? null,
  };
}

/**
 * pm2-Umgebung; im Testmodus zeigt ecosystem.config.js über QM_DEPLOY_DIR auf `.deploy/test` und übernimmt
 * `--test-user` über QM_SERVICE_USER (nur zusammen mit QM_DEPLOY_DIR erlaubt).
 */
function pm2EnvFor(layout: Layout, mode: SourceContext["mode"]): Record<string, string> {
  if (mode !== "test") return pm2Env();
  const testUser = values["test-user"];
  return {
    ...pm2Env(),
    QM_DEPLOY_DIR: layout.deployDir,
    ...(testUser === undefined ? {} : { QM_SERVICE_USER: testUser }),
  };
}

/** lib/ProcessContainerFork.js der verwendeten pm2-Installation (lädt im App-Prozess die App) oder null. */
function pm2ContainerPath(pm2Bin: string): string | null {
  try {
    const file = join(dirname(realpathSync(pm2Bin)), "..", "lib", "ProcessContainerFork.js");
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/**
 * Unmittelbar vor der Aktivierung: Besitz und Rechte für den Dienstbenutzer herstellen und prüfen (lib/access.ts)
 * – für das Ziel und den Rückweg. Wirft, bevor etwas umgeschaltet wird.
 */
async function prepareServiceAccess(ctx: DeployContext, tools: Tools, releases: ReadonlyArray<string | null>) {
  step(ctx.identity.kind === "service" ? `Rechte für ${ctx.identity.user}` : "Rechte (ohne Dienstbenutzer)");
  const lines = await prepareAccess({
    layout: ctx.layout,
    identity: ctx.identity,
    releases: releases.filter((sha): sha is string => sha !== null),
    externalFiles: mongoUriFiles(ctx.source.resolved.source.MONGODB_URI),
    pm2Container: pm2ContainerPath(tools.pm2),
    rootCode: [
      { label: "ecosystem.config.js", path: ctx.layout.ecosystem },
      {
        label: "scripts/deploy/service-user.cjs",
        path: join(ctx.layout.root, "scripts", "deploy", "service-user.cjs"),
      },
    ],
  });
  for (const line of lines) ok(line);
  stopIfInterrupted();
}

/**
 * Env-Dateien vor einer Aktivierung sichern – der Rückweg startet mit exakt den vorherigen Dateien (auch wenn
 * eine Änderung an .env.prod die Ursache des Fehlers war). Ohne vorherige Datei: neu aus der Quelle.
 */
function snapshotEnv(layout: Layout, fallbackFrom: EnvProvider): EnvProvider {
  const saved = new Map<AppKey, string>();
  for (const app of APP_KEYS) {
    const file = envFile(layout, app);
    if (existsSync(file) && readRelease(file) !== null) saved.set(app, readFileSync(file, "utf8"));
  }
  return (app, sha) => saved.get(app) ?? fallbackFrom(app, sha);
}

function record(layout: Layout, entry: HistoryEntry, update?: (state: DeployState) => DeployState): DeployState {
  let state = readState(layout.stateFile);
  if (update) state = update(state);
  state = addHistory(state, entry);
  writeState(layout.stateFile, state);
  return state;
}

/** Grund für eine Datenbank-Sicherung vor der Aktivierung (null = nicht nötig; Testdeploys sichern nie). */
async function databaseBackupReason(
  repo: string,
  source: SourceContext,
  from: string | null,
  to: string,
): Promise<string | null> {
  if (source.mode === "test") return null;
  return backupReason(from, from === null ? [] : await changedPaths(repo, from, to, SCHEMA_PATHS));
}

function describeBackupPlan(source: SourceContext, reason: string | null): void {
  if (source.mode === "test") info("Testmodus: keine Datenbank-Sicherung (Test-DB)");
  else if (reason === null) info("Schema-Dateien unverändert – keine Datenbank-Sicherung vor der Aktivierung nötig");
  else {
    info(
      `Datenbank-Sicherung vor der Aktivierung: ${reason}` +
        (values["skip-backup"] ? " – ÜBERSPRUNGEN (--skip-backup)" : ""),
    );
  }
}

/** Unmittelbar vor der Aktivierung: Datenbank sichern, falls `reason`. Fehler brechen ab, bevor etwas umschaltet. */
async function backupBeforeActivation(reason: string | null): Promise<void> {
  if (reason === null) return;
  if (values["skip-backup"]) {
    warn(`Datenbank-Sicherung übersprungen (--skip-backup) – ${reason}`);
    return;
  }
  step(`Datenbank-Sicherung vor der Aktivierung (${reason})`);
  await runDatabaseBackup(ROOT);
  ok("Datenbank verschlüsselt gesichert (/var/backups/quizmaster) – Wiederherstellung: pnpm ops:restore");
  stopIfInterrupted();
}

/** Nach der Aktivierung: erreicht /api/health auch über den Host-Caddy die neue App? Nur Produktion, nur Warnung. */
async function checkCaddyPath(source: SourceContext): Promise<void> {
  const domain = source.resolved.domain;
  if (source.mode !== "prod" || !domain) return;
  step("Kontrolle über Caddy");
  try {
    const result = await checkSiteViaCaddy({
      domain,
      path: "/api/health",
      certFile: source.resolved.source.TLS_CERT_FILE,
      timeoutMs: 10_000,
    });
    if (result.certificateMatches === false) {
      warn(`Caddy liefert für ${domain} ein anderes Zertifikat als TLS_CERT_FILE – pnpm caddy:dry-run`);
    }
    if (result.status === 200 || result.status === 429) {
      ok(
        `https://${domain}/api/health über Caddy (Loopback) → HTTP ${result.status}` +
          (result.certificateMatches ? ", Zertifikat = TLS_CERT_FILE" : ""),
      );
    } else {
      warn(
        `https://${domain}/api/health über Caddy → HTTP ${result.status} – Caddy-Site aktuell? (pnpm caddy:dry-run)`,
      );
    }
  } catch (error) {
    warn(
      `Caddy über Loopback nicht erreichbar (${describeError(error)}) – Caddy-Site installiert? (pnpm caddy:dry-run)`,
    );
  }
}

/** Ergebnis von persistProcessList – nur Namen und Status fremder Apps, nie Werte. */
function reportPersist(result: PersistResult): void {
  const saved = result.backup ? ` (vorheriges dump.pm2 gesichert: ${result.backup})` : "";
  const { merge } = result;
  if (merge.merged) {
    ok(`pm2 save: ${merge.ours} quizmaster-Einträge aktualisiert, ${merge.keptForeign} fremde unverändert${saved}`);
    if (merge.drift.length > 0) {
      info(`Hinweis: ${merge.drift.length} fremde App(s) weichen vom gespeicherten Boot-Zustand ab (bleibt so):`);
      for (const line of merge.drift.slice(0, 10)) info(`  ${line}`);
      if (merge.drift.length > 10) info(`  … (+${merge.drift.length - 10})`);
    }
  } else {
    warn(`dump.pm2: ${merge.reason} – pm2 save hat den vollständigen aktuellen Zustand gespeichert${saved}`);
  }
  if (result.pruned > 0) info(`${result.pruned} alte dump.pm2-Sicherung(en) gelöscht (max. ${KEEP_DUMP_BACKUPS})`);
}

async function applyRetention(layout: Layout, state: DeployState, protect: ReadonlySet<string>): Promise<void> {
  const existing = listReleases(layout);
  const doomed = releasesToDelete(state, existing, KEEP_RELEASES, protect);
  for (const sha of doomed) {
    // GNU rm statt einer Schleife als root: .next/cache gehört ggf. dem Dienstbenutzer (lib/access.ts).
    await removeTree(releaseDir(layout, sha));
    info(`altes Release ${short(sha)} gelöscht`);
  }
  const remaining = new Set(listReleases(layout));
  writeState(layout.stateFile, pruneStack(readState(layout.stateFile), remaining));
  ok(`Releases behalten: ${remaining.size} (max. ${KEEP_RELEASES})`);
}

/** Abbruchpunkt zwischen zwei Schritten (vor der Aktivierung) – `finally`-Blöcke räumen auf. */
function stopIfInterrupted(): void {
  interrupts?.checkpoint("abgebrochen vor der Aktivierung – nichts wurde umgeschaltet");
}

/**
 * Aktivierung, Rückweg, state.json und `pm2 save` laufen auch bei Abbruchsignalen (Strg+C, SIGTERM, SSH-Abbruch)
 * zu Ende – sonst bliebe `current` umgehängt, während Apps gemischt laufen und kein Rückweg stattfindet.
 */
function critical<T>(fn: () => Promise<T>): Promise<T> {
  return interrupts ? interrupts.critical(fn) : fn();
}

/**
 * `current` muss nach jeder abgeschlossenen Aktion auf das oberste Release des Stapels zeigen. Weicht es ab, wurde
 * eine Aktivierung hart beendet (z. B. kill -9) – Apps laufen dann womöglich gemischt aus zwei Releases.
 */
function warnIfIncomplete(layout: Layout): void {
  let top: string | null;
  try {
    top = currentOf(readState(layout.stateFile));
  } catch {
    return; // state.json defekt – meldet readState an der Stelle, an der es gebraucht wird
  }
  const current = currentRelease(layout);
  if (current === top) return;
  warn(
    `unvollständige Aktivierung erkannt: current → ${current ? short(current) : "keins"}, zuletzt erfolgreich ` +
      `aktiviert: ${top ? short(top) : "keins"} – Apps laufen evtl. gemischt. Abhilfe: pnpm deploy:prod --sha ` +
      `${current ? short(current) : "<sha>"} erneut oder pnpm deploy:rollback (Zustand: pnpm deploy:status)`,
  );
}

// ── Befehle ──────────────────────────────────────────────────────────────────

async function commandDeploy(): Promise<void> {
  const testEnv = guardTestMode();
  const layout = layoutFor(ROOT, testEnv ? "test" : "prod");
  const repo = values.repo ? resolve(values.repo) : ROOT;
  step(`Preflight${testEnv ? " (Testmodus)" : ""}`);
  const tools = checkTools();
  await checkPnpmVersion(tools.pnpm);
  const sha = await resolveCommit(repo, values.sha ?? "HEAD");
  const subject = await commitSubject(repo, sha);
  ok(`Revision ${short(sha)} – ${subject}`);
  await checkWorktree(repo, values.sha !== undefined);
  const source = loadSource(ROOT, testEnv);
  ok(
    `${source.label} gültig: Origin ${source.resolved.appOrigin}, Web :${source.resolved.webPort}, Realtime :${source.resolved.realtimePort}`,
  );
  await runEnvCheck(source);
  const home = pm2Home();
  checkDaemon(home, source.mode);
  const identity = checkIdentity();
  const ctx = createContext(layout, tools, source, identity);
  await checkPorts(daemonAlive(home) ? ctx.pm2 : null, source);
  checkDisk(layout);

  warnIfIncomplete(layout);
  const current = currentRelease(layout);
  const existing = readReleaseMeta(layout, sha);
  const reuse = existing !== null && (!values.rebuild || sha === current);
  if (values.rebuild && sha === current)
    warn("--rebuild für das laufende Release nicht möglich – es wird neu aktiviert");
  info(
    `aktuell: ${current ? short(current) : "kein Release"} → Ziel: ${short(sha)}${reuse ? " (Release vorhanden, kein Build)" : ""}`,
  );
  const backupNeed = await databaseBackupReason(repo, source, current, sha);
  describeBackupPlan(source, backupNeed);

  if (values["dry-run"]) {
    step("Dry-Run: Audit-Gate auf dem Ziel-Commit (nichts wird verändert)");
    const scratch = mkdtempSync(join(tmpdir(), "quizmaster-deploy-"));
    try {
      await extractArchive(repo, sha, scratch);
      const buildCtx: BuildContext = { layout, repo, sha, subject, pnpm: tools.pnpm, env: releaseBuildEnv(sha) };
      if (values["skip-audit"]) warn("Audit-Gate übersprungen (--skip-audit)");
      else await auditGate(buildCtx, scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    step("Dry-Run beendet – keine Änderungen");
    info(`würde ${reuse ? "Release wiederverwenden" : "bauen"}, dann web → realtime → watchdog aktivieren`);
    return;
  }

  const lock = acquireLock(layout.lockFile, `deploy ${short(sha)}`);
  try {
    step("Node-Laufzeit");
    const runtime = await ensureRuntime(layout);
    ok(`Interpreter: ${relative(ROOT, runtime.node)} → ${runtime.version}`);

    step("Build");
    const buildCtx: BuildContext = { layout, repo, sha, subject, pnpm: tools.pnpm, env: releaseBuildEnv(sha) };
    try {
      const dir = await prepareSource(buildCtx);
      if (values["skip-audit"]) warn("Audit-Gate übersprungen (--skip-audit) – nur im Notfall!");
      else await auditGate(buildCtx, dir);
      stopIfInterrupted();
      if (reuse) ok(`Release ${short(sha)} ist bereits gebaut – wird wiederverwendet`);
      else await buildRelease(buildCtx, dir);
    } finally {
      await cleanupBuild(layout);
    }
    stopIfInterrupted();

    step("Env-Split je App");
    const envFor = envFromSource(ctx);
    for (const app of APP_KEYS) envFor(app, sha); // wirft vor der Aktivierung, falls ein Wert nicht schreibbar ist
    ok(`web.env, realtime.env, watchdog.env aus ${source.label} (nur die Schlüssel je App, RELEASE=${short(sha)})`);
    stopIfInterrupted();
    await backupBeforeActivation(backupNeed);
    await prepareServiceAccess(ctx, tools, [sha, current]);

    await critical(async () => {
      step("Aktivieren");
      const fallback = current;
      try {
        await activate(ctx, {
          target: sha,
          fallback,
          apps: ["web", "realtime", "watchdog"],
          envFor,
          fallbackEnvFor: snapshotEnv(layout, envFor),
        });
      } catch (error) {
        record(layout, {
          at: nowIso(),
          action: "deploy",
          sha,
          from: current,
          result: error instanceof ActivationError && error.reverted ? "rolled_back" : "failed",
          message: describeError(error).slice(0, 500),
        });
        throw error;
      }
      record(layout, { at: nowIso(), action: "deploy", sha, from: current, result: "ok" }, (previous) =>
        pushActivation(previous, sha, nowIso()),
      );

      step("Prozessliste sichern");
      reportPersist(await persistProcessList(ctx));
    });
    await checkCaddyPath(source);

    step("Aufräumen");
    await applyRetention(layout, readState(layout.stateFile), new Set([sha, ...(current ? [current] : [])]));

    step(`Fertig: Release ${short(sha)} aktiv – ${subject}`);
    info(
      `Web 127.0.0.1:${source.resolved.webPort}, Realtime 127.0.0.1:${source.resolved.realtimePort}, Origin ${source.resolved.appOrigin}`,
    );
    info(`Rollback: pnpm deploy:rollback${current && current !== sha ? ` (→ ${short(current)})` : ""}`);
  } finally {
    lock.release();
  }
}

async function commandRollback(): Promise<void> {
  const testEnv = guardTestMode();
  const layout = layoutFor(ROOT, testEnv ? "test" : "prod");
  step(`Rollback – Preflight${testEnv ? " (Testmodus)" : ""}`);
  const tools = checkTools();
  const source = loadSource(ROOT, testEnv);
  const home = pm2Home();
  checkDaemon(home, source.mode);
  const identity = checkIdentity();
  warnIfIncomplete(layout);
  const current = currentRelease(layout);
  const state = readState(layout.stateFile);
  let target: string;
  if (values.to !== undefined) {
    const wanted = values.to.toLowerCase();
    const matches = listReleases(layout).filter((sha) => sha.startsWith(wanted));
    if (wanted.length < 7 || matches.length !== 1 || !matches[0]) {
      throw new DeployError("ROLLBACK_TARGET", `kein eindeutiges vorhandenes Release zu ${values.to} (min. 7 Zeichen)`);
    }
    target = matches[0];
  } else {
    const candidates = [...state.stack].reverse().map((entry) => entry.sha);
    const found = candidates.find((sha) => sha !== current && readReleaseMeta(layout, sha) !== null);
    if (!found) throw new DeployError("NO_PREVIOUS_RELEASE", "kein vorheriges Release vorhanden");
    target = found;
  }
  if (target === current) throw new DeployError("ROLLBACK_TARGET", `Release ${short(target)} läuft bereits`);
  const meta = readReleaseMeta(layout, target);
  if (!meta) throw new DeployError("ROLLBACK_TARGET", `Release ${short(target)} ist unvollständig`);
  ok(`Ziel: ${short(target)} – ${meta.subject} (gebaut ${meta.builtAt})`);
  const backupNeed = await databaseBackupReason(ROOT, source, current, target);
  describeBackupPlan(source, backupNeed);
  if (values["dry-run"]) {
    step("Dry-Run beendet – keine Änderungen");
    return;
  }

  const lock = acquireLock(layout.lockFile, `rollback ${short(target)}`);
  try {
    const ctx = createContext(layout, tools, source, identity);
    step("Node-Laufzeit");
    await ensureRuntime(layout);
    const envFor = envFromSource(ctx);
    stopIfInterrupted();
    await backupBeforeActivation(backupNeed);
    await prepareServiceAccess(ctx, tools, [target, current]);
    await critical(async () => {
      step(`Aktivieren von ${short(target)}`);
      try {
        await activate(ctx, {
          target,
          fallback: current,
          apps: ["web", "realtime", "watchdog"],
          envFor,
          fallbackEnvFor: snapshotEnv(layout, envFor),
        });
      } catch (error) {
        record(layout, {
          at: nowIso(),
          action: "rollback",
          sha: target,
          from: current,
          result: error instanceof ActivationError && error.reverted ? "rolled_back" : "failed",
          message: describeError(error).slice(0, 500),
        });
        throw error;
      }
      record(layout, { at: nowIso(), action: "rollback", sha: target, from: current, result: "ok" }, (previous) => {
        if (values.to !== undefined) return pushActivation(previous, target, nowIso());
        // Schrittweise zurück: alles oberhalb des Ziels abnehmen.
        const index = previous.stack.map((entry) => entry.sha).lastIndexOf(target);
        return { ...previous, stack: previous.stack.slice(0, index + 1) };
      });
      step("Prozessliste sichern");
      reportPersist(await persistProcessList(ctx));
    });
    await checkCaddyPath(source);
    step(`Fertig: Release ${short(target)} aktiv (vorher ${current ? short(current) : "keins"})`);
  } finally {
    lock.release();
  }
}

async function commandRestart(): Promise<void> {
  const testEnv = guardTestMode();
  const layout = layoutFor(ROOT, testEnv ? "test" : "prod");
  const requested = (values.apps ?? APP_KEYS.join(","))
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const invalid = requested.filter((app) => !(APP_KEYS as readonly string[]).includes(app));
  if (invalid.length > 0 || requested.length === 0) {
    throw new DeployError("USAGE", `--apps erwartet web, realtime, watchdog (kommagetrennt)`);
  }
  const apps = APP_KEYS.filter((app) => requested.includes(app));
  step(`Neustart mit frischer Env – Preflight${testEnv ? " (Testmodus)" : ""}`);
  const tools = checkTools();
  const source = loadSource(ROOT, testEnv);
  await runEnvCheck(source);
  const home = pm2Home();
  checkDaemon(home, source.mode);
  const identity = checkIdentity();
  const current = currentRelease(layout);
  if (!current || !readReleaseMeta(layout, current)) throw new DeployError("NO_RELEASE", "kein aktives Release");
  ok(`Release ${short(current)}, Apps: ${apps.map((app) => APPS[app].name).join(", ")}`);
  if (values["dry-run"]) {
    step("Dry-Run beendet – keine Änderungen");
    return;
  }
  const lock = acquireLock(layout.lockFile, `restart ${apps.join(",")}`);
  try {
    const ctx = createContext(layout, tools, source, identity);
    await ensureRuntime(layout);
    const envFor = envFromSource(ctx);
    stopIfInterrupted();
    await prepareServiceAccess(ctx, tools, [current]);
    await critical(async () => {
      try {
        await activate(ctx, {
          target: current,
          fallback: current,
          apps,
          envFor,
          fallbackEnvFor: snapshotEnv(layout, envFor),
        });
      } catch (error) {
        record(layout, {
          at: nowIso(),
          action: "restart",
          sha: current,
          from: current,
          result: error instanceof ActivationError && error.reverted ? "rolled_back" : "failed",
          message: describeError(error).slice(0, 500),
        });
        throw error;
      }
      record(layout, { at: nowIso(), action: "restart", sha: current, from: current, result: "ok" });
      step("Prozessliste sichern");
      reportPersist(await persistProcessList(ctx));
    });
    if (apps.includes("web")) await checkCaddyPath(source);
    step("Fertig");
  } finally {
    lock.release();
  }
}

/** Effektiver Benutzer eines Prozesses („als quizmaster“) – pm2 zeigt in `user` nur den Aufrufer (root). */
function processUser(pid: number): string {
  if (pid <= 0) return "als –";
  try {
    return `als ${userLabel(readProcStatus(pid).uids[1] ?? -1)}`;
  } catch {
    return "als ?";
  }
}

async function commandStatus(): Promise<void> {
  const testEnv = guardTestMode();
  const layout = layoutFor(ROOT, testEnv ? "test" : "prod");
  const current = currentRelease(layout);
  const state = readState(layout.stateFile);
  step("Status");
  warnIfIncomplete(layout);
  const describe = (sha: string | null) => {
    if (!sha) return "–";
    const meta = readReleaseMeta(layout, sha);
    return meta
      ? `${short(sha)} – ${meta.subject} (gebaut ${meta.builtAt})`
      : `${short(sha)} (Verzeichnis fehlt/unvollständig)`;
  };
  info(`aktuell:   ${describe(current)}`);
  const previous = [...state.stack].reverse().find((entry) => entry.sha !== current)?.sha ?? null;
  info(`vorherig:  ${describe(previous)} ← Ziel von pnpm deploy:rollback`);
  const releases = listReleases(layout);
  info(`Releases:  ${releases.length > 0 ? releases.map(short).join(", ") : "keine"}`);
  let identity: ServiceIdentity | null = null;
  try {
    identity = resolveIdentity();
    info(`Benutzer:  ${describeIdentity(identity)}`);
  } catch (error) {
    warn(`Dienstbenutzer unklar – ${describeError(error)}`);
  }
  if (identity?.kind === "root") warn(`kein Dienstbenutzer ${identity.user} – die Apps laufen als root`);
  for (const app of APP_KEYS) {
    const file = envFile(layout, app);
    const release = readRelease(file);
    const access = release ? `, ${describeStat(statSync(file))}` : "";
    info(`${app}.env:  ${release ? `RELEASE ${short(release)}${access}` : "fehlt"}`);
  }
  if (current && readReleaseMeta(layout, current)?.hasWatchdog === false) {
    warn("aktives Release ohne Watchdog – Ausfälle meldet nur infra/ops/healthcheck.sh (Cron), keine /metrics-Alarme");
  }
  const home = pm2Home();
  if (!daemonAlive(home)) {
    warn(`pm2-Daemon in ${home} läuft nicht`);
  } else {
    const pm2Bin = which("pm2") ?? which("pm2", SYSTEM_PATH);
    if (pm2Bin) {
      const pm2 = createPm2({
        bin: pm2Bin,
        env: pm2EnvFor(layout, testEnv ? "test" : "prod"),
        ecosystem: layout.ecosystem,
      });
      const list = await pm2.list(APP_NAMES);
      for (const app of APP_KEYS) {
        const entry = list.find((item) => item.name === APPS[app].name);
        const memory = entry?.memoryBytes ? `${Math.round(entry.memoryBytes / 1024 ** 2)} MB` : "–";
        const since = entry?.startedAt ? new Date(entry.startedAt).toISOString() : "–";
        info(
          entry
            ? `${APPS[app].name.padEnd(20)} ${entry.status.padEnd(8)} PID ${entry.pid}  ${processUser(entry.pid)}  ↺ ${entry.restarts}  ${memory}  seit ${since}`
            : `${APPS[app].name.padEnd(20)} nicht in pm2`,
        );
      }
    }
  }
  const last = state.history.slice(-5);
  if (last.length > 0) {
    info("letzte Aktionen:");
    for (const entry of last) {
      info(
        `  ${entry.at}  ${entry.action.padEnd(8)} ${short(entry.sha)}  ${entry.result}${entry.message ? `  (${entry.message})` : ""}`,
      );
    }
  }
}

// ── Einstieg ─────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  if (values.help || !command || !["deploy", "rollback", "restart", "status"].includes(command)) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  process.umask(0o022);
  // SIGINT/SIGTERM/SIGHUP nur vormerken; Aktivierung bis `pm2 save` läuft immer zu Ende (lib/interrupt.ts).
  const active = installInterrupts();
  interrupts = active;
  if (command === "deploy") await commandDeploy();
  else if (command === "rollback") await commandRollback();
  else if (command === "restart") await commandRestart();
  else await commandStatus();
  return active.exitCode() ?? 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`\ndeploy – FEHLER ${describeError(error)}`);
    if (error instanceof ActivationError && !error.reverted) process.exit(3);
    process.exit(error instanceof DeployError && error.code === "USAGE" ? 2 : 1);
  },
);
