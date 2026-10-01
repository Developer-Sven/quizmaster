/**
 * Aktivieren eines Releases (ADR-024/025): `current` atomar umhängen, Apps in der Reihenfolge
 * web → Smoke web → realtime → Smoke realtime → watchdog starten, bei jedem Fehler automatisch auf den
 * vorherigen Stand zurück (Symlink, Env-Dateien, genau die angefassten Apps) und mit Fehler enden.
 *
 * Smoke-Test: Web `GET /api/health` 200 über 127.0.0.1:QUIZMASTER_PORT, die Startseite als HTML mit CSP-Nonce,
 * die ihre Skripte tragen, und ein darin referenziertes /_next/static-Asset (fehlt .next/static im Release oder
 * stimmt die Nonce nicht, wäre die Seite im Browser kaputt, obwohl /api/health antwortet). Realtime `GET
 * /healthz` 200, Socket.IO-Handshake ohne Ticket (Polling + WebSocket) wird mit UNAUTHORIZED abgelehnt,
 * `/metrics` ist ohne Token nicht lesbar. Zusätzlich: der Port gehört dem neuen pm2-Prozess und lauscht nur auf
 * Loopback, und dessen Arbeitsverzeichnis liegt im erwarteten Release. Jede App läuft mit der erwarteten Identität
 * (/proc/<pid>/status): mit Dienstbenutzer dessen uid/gid ohne Zusatzgruppen – also nie root –, ohne ihn als
 * Benutzer des Deploys (root). Nicht abgedeckt (siehe README): ein Lobby-Durchlauf mit Session + Ticket und die
 * Bereitschaft von Mongo/Change Streams (Aufgabe des Watchdogs).
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { ServiceIdentity } from "../service-user.cjs";
import { appIdentity, describeIdentity, envAccess, identityMismatch, readProcStatus } from "./access.ts";
import { readReleaseMeta } from "./build.ts";
import { renderAppEnvFile, writeFileAtomic } from "./envfiles.ts";
import { APP_NAMES, APPS, type AppKey, envFile, type Layout, releaseDir, SHA_PATTERN } from "./layout.ts";
import { DeployError, describeError, fail, info, ok, short, stamp, step, warn } from "./log.ts";
import {
  httpRequest,
  judgeStartPage,
  listListeners,
  pollingHandshake,
  waitForHealth,
  websocketHandshake,
} from "./net.ts";
import type { Pm2App, Pm2Client } from "./pm2.ts";
import {
  type DumpMergeResult,
  mergeDump,
  type PreviousDump,
  pruneDumpBackups,
  readIfExists,
  replaceKeepingMode,
} from "./pm2-dump.ts";
import type { SourceContext } from "./source-env.ts";

export interface DeployContext {
  layout: Layout;
  pm2: Pm2Client;
  pm2Home: string;
  source: SourceContext;
  /** Benutzer der Apps (ecosystem.config.js): Dienstbenutzer oder Rückfall root – bestimmt Env-Rechte und Smoke. */
  identity: ServiceIdentity;
  /** Zielordner für dump.pm2-Sicherungen (…/<zeitstempel>/dump.pm2). */
  backupRoot: string;
  /** Nur Tests (--simulate-failure): Smoke-Test dieser App schlägt absichtlich fehl (nicht auf dem Rückweg). */
  simulateFailure: AppKey | null;
  /** Nur Unit-Tests: Smoke-Test ersetzen (Standard: echte HTTP-/Socket-/Port-Prüfungen). */
  smokeTest?: SmokeTest;
  /** Nur Unit-Tests: Wartezeit der Stabilitätsprüfung nach dem Smoke-Test (Standard 3 s). */
  settleMs?: number;
}

/** Prüft eine frisch gestartete App; wirft bei Fehlern. */
export type SmokeTest = (app: AppKey, sha: string, proc: Pm2App) => Promise<void>;

/** Env-Inhalt je App und Release. */
export type EnvProvider = (app: AppKey, sha: string) => string;

export function envFromSource(ctx: DeployContext): EnvProvider {
  return (app, sha) => renderAppEnvFile(ctx.source.resolved, app, sha, ctx.source.label);
}

/** SHA, auf das `current` zeigt (oder null). */
export function currentRelease(layout: Layout): string | null {
  try {
    const sha = basename(readlinkSync(layout.current));
    return SHA_PATTERN.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** `current` atomar auf `releases/<sha>` setzen (relativer Link) bzw. entfernen. */
export function switchCurrent(layout: Layout, sha: string | null): void {
  if (sha === null) {
    rmSync(layout.current, { force: true });
    return;
  }
  if (!existsSync(releaseDir(layout, sha))) throw new DeployError("RELEASE_MISSING", `Release ${short(sha)} fehlt`);
  const tmp = join(layout.deployDir, `.current.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  symlinkSync(join("releases", sha), tmp);
  renameSync(tmp, layout.current);
}

const sleep = (ms: number) => new Promise((resolveTimer) => setTimeout(resolveTimer, ms));

async function findApp(ctx: DeployContext, app: AppKey): Promise<Pm2App | null> {
  const [entry] = await ctx.pm2.list([APPS[app].name]);
  return entry ?? null;
}

async function waitOnline(ctx: DeployContext, app: AppKey, timeoutMs = 30_000): Promise<Pm2App> {
  const deadline = Date.now() + timeoutMs;
  let last: Pm2App | null = null;
  while (Date.now() < deadline) {
    last = await findApp(ctx, app);
    if (last && last.status === "online" && last.pid > 0) return last;
    await sleep(500);
  }
  throw new DeployError(
    "APP_NOT_ONLINE",
    `${APPS[app].name} ist nicht online (Status ${last?.status ?? "unbekannt"}) – Logs: pm2 logs ${APPS[app].name}`,
  );
}

function verifyReleaseDir(layout: Layout, app: AppKey, pid: number, sha: string): void {
  let cwd: string;
  try {
    cwd = realpathSync(`/proc/${pid}/cwd`);
  } catch {
    throw new DeployError("APP_CWD", `${APPS[app].name}: Arbeitsverzeichnis von PID ${pid} nicht lesbar`);
  }
  const expected = realpathSync(releaseDir(layout, sha));
  if (!`${cwd}/`.startsWith(`${expected}/`)) {
    throw new DeployError("APP_WRONG_RELEASE", `${APPS[app].name} läuft nicht aus Release ${short(sha)}`);
  }
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

async function verifyPortOwner(app: AppKey, port: number, pid: number): Promise<void> {
  const listeners = (await listListeners()).filter((listener) => listener.port === port);
  if (listeners.length === 0) throw new DeployError("PORT_NOT_LISTENING", `niemand lauscht auf Port ${port}`);
  for (const listener of listeners) {
    if (!listener.pids.includes(pid)) {
      throw new DeployError(
        "PORT_FOREIGN",
        `Port ${port} (${listener.address}) gehört PID ${listener.pids.join(",") || "?"}, nicht ${APPS[app].name} (PID ${pid})`,
      );
    }
    if (!LOOPBACK.has(listener.address)) {
      throw new DeployError("PORT_PUBLIC", `${APPS[app].name} lauscht auf ${listener.address}:${port} statt 127.0.0.1`);
    }
  }
}

/** Ist die App seit dem Start neu gestartet (Absturz beim Hochfahren)? Dann gilt der Smoke-Test als gescheitert. */
async function assertNotRestarted(ctx: DeployContext, app: AppKey, proc: Pm2App): Promise<void> {
  const now = await findApp(ctx, app);
  if (now?.pid !== proc.pid || now.restarts !== proc.restarts || now.status !== "online") {
    throw new DeployError(
      "APP_RESTARTED",
      `${APPS[app].name} ist während des Smoke-Tests abgestürzt/neu gestartet (PID ${proc.pid} → ${now?.pid ?? "–"}) – pm2 logs ${APPS[app].name}`,
    );
  }
}

/** Läuft der Prozess mit der erwarteten uid/gid (Dienstbenutzer: auch ohne Zusatzgruppen)? */
function verifyIdentity(ctx: DeployContext, app: AppKey, pid: number): void {
  const expected = appIdentity(ctx.identity);
  let mismatch: string | null;
  try {
    mismatch = identityMismatch(readProcStatus(pid), expected, ctx.identity.kind === "service");
  } catch (error) {
    throw new DeployError(
      "APP_IDENTITY",
      `${APPS[app].name}: Identität von PID ${pid} nicht prüfbar (${describeError(error)})`,
    );
  }
  if (mismatch !== null) {
    throw new DeployError(
      "APP_IDENTITY",
      `${APPS[app].name} läuft mit ${mismatch} – erwartet ${describeIdentity(ctx.identity)}`,
    );
  }
  if (ctx.identity.kind === "service") {
    ok(`${APPS[app].name} läuft als ${ctx.identity.user} (uid ${expected.uid}, gid ${expected.gid}), nicht als root`);
  } else {
    info(`${APPS[app].name} läuft als uid ${expected.uid} – ${describeIdentity(ctx.identity)}`);
  }
}

async function smoke(ctx: DeployContext, app: AppKey, sha: string, proc: Pm2App): Promise<void> {
  const { resolved } = ctx.source;
  verifyIdentity(ctx, app, proc.pid);
  if (app === "web") {
    const health = await waitForHealth("127.0.0.1", resolved.webPort, "/api/health", 90_000);
    if (!health.ok)
      throw new DeployError("SMOKE_WEB", `GET /api/health: ${health.detail} (${health.attempts} Versuche)`);
    ok(`Web: GET 127.0.0.1:${resolved.webPort}/api/health → 200`);
    await assertNotRestarted(ctx, app, proc);
    await verifyPortOwner(app, resolved.webPort, proc.pid);
    verifyReleaseDir(ctx.layout, app, proc.pid, sha);
    ok(`Web: Port ${resolved.webPort} gehört PID ${proc.pid} (nur Loopback), läuft aus Release ${short(sha)}`);
    const page = judgeStartPage(
      await httpRequest({
        method: "GET",
        host: "127.0.0.1",
        port: resolved.webPort,
        path: "/",
        headers: { accept: "text/html", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
        timeoutMs: 15_000,
        maxBody: 2 * 1024 * 1024,
      }),
    );
    if (!page.ok || page.asset === null) throw new DeployError("SMOKE_WEB_PAGE", `GET /: ${page.detail}`);
    const asset = await httpRequest({
      method: "GET",
      host: "127.0.0.1",
      port: resolved.webPort,
      path: page.asset,
      timeoutMs: 10_000,
      maxBody: 1,
    });
    if (asset.status !== 200) {
      throw new DeployError("SMOKE_WEB_STATIC", `GET ${page.asset}: HTTP ${asset.status} (.next/static im Release?)`);
    }
    ok(`Web: Startseite mit CSP-Nonce, ${page.asset} → 200`);
    return;
  }
  if (app === "realtime") {
    const health = await waitForHealth("127.0.0.1", resolved.realtimePort, "/healthz", 60_000);
    if (!health.ok) {
      throw new DeployError("SMOKE_REALTIME", `GET /healthz: ${health.detail} (${health.attempts} Versuche)`);
    }
    ok(`Realtime: GET 127.0.0.1:${resolved.realtimePort}/healthz → 200`);
    await assertNotRestarted(ctx, app, proc);
    await verifyPortOwner(app, resolved.realtimePort, proc.pid);
    verifyReleaseDir(ctx.layout, app, proc.pid, sha);
    ok(
      `Realtime: Port ${resolved.realtimePort} gehört PID ${proc.pid} (nur Loopback), läuft aus Release ${short(sha)}`,
    );
    const polling = await pollingHandshake(resolved.realtimePort, resolved.appOrigin, 15_000).catch(
      (error: unknown) => ({ ok: false, detail: describeError(error) }),
    );
    if (!polling.ok) throw new DeployError("SMOKE_HANDSHAKE", `Socket.IO (Polling) ohne Ticket: ${polling.detail}`);
    ok("Realtime: Socket.IO-Handshake ohne Ticket (Polling) → UNAUTHORIZED");
    const websocket = await websocketHandshake(resolved.realtimePort, resolved.appOrigin, 15_000);
    if (!websocket.ok) {
      throw new DeployError("SMOKE_HANDSHAKE", `Socket.IO (WebSocket) ohne Ticket: ${websocket.detail}`);
    }
    ok("Realtime: Socket.IO-Handshake ohne Ticket (WebSocket) → UNAUTHORIZED");
    const metrics = await httpRequest({
      method: "GET",
      host: "127.0.0.1",
      port: resolved.realtimePort,
      path: "/metrics",
      timeoutMs: 5_000,
    });
    if (metrics.status === 200) throw new DeployError("SMOKE_METRICS", "/metrics ist ohne Token lesbar");
    ok(`Realtime: /metrics ohne Token → HTTP ${metrics.status}`);
    return;
  }
  // Watchdog: kein Port – muss laufen und darf in den ersten Sekunden nicht neu starten.
  await sleep(5_000);
  await assertNotRestarted(ctx, app, proc);
  verifyReleaseDir(ctx.layout, app, proc.pid, sha);
  ok(`Watchdog: seit ≥ 5 s online, läuft aus Release ${short(sha)}`);
}

async function removeApp(ctx: DeployContext, app: AppKey, reason: string): Promise<boolean> {
  if (!(await findApp(ctx, app))) return false;
  await ctx.pm2.remove(APPS[app].name);
  info(`${APPS[app].name} aus pm2 entfernt (${reason})`);
  return true;
}

type BringUpResult = { kind: "started"; proc: Pm2App } | { kind: "removed" } | { kind: "skipped" };

/** Startet eine App passend zum Release (bzw. entfernt den Watchdog, wenn das Release keinen enthält). */
async function bringUp(
  ctx: DeployContext,
  app: AppKey,
  sha: string,
  envFor: EnvProvider,
  simulate: boolean,
): Promise<BringUpResult> {
  if (app === "watchdog" && !readReleaseMeta(ctx.layout, sha)?.hasWatchdog) {
    const reason = `Release ${short(sha)} enthält kein dist/watchdog.mjs`;
    // Sichtbar, nicht still: ohne Watchdog meldet nur infra/ops/healthcheck.sh (Cron) Ausfälle.
    warn(`Watchdog: ${reason} – keine Alarme aus /metrics; Ausfälle meldet nur infra/ops/healthcheck.sh (Cron)`);
    if (await removeApp(ctx, app, reason)) return { kind: "removed" };
    return { kind: "skipped" };
  }
  step(`Start ${APPS[app].name} (Release ${short(sha)})`);
  writeFileAtomic(envFile(ctx.layout, app), envFor(app, sha), envAccess(ctx.identity));
  for (const message of await ctx.pm2.startOrReload(APPS[app].name)) info(message);
  const proc = await waitOnline(ctx, app);
  ok(`${APPS[app].name} online (PID ${proc.pid})`);
  if (simulate && ctx.simulateFailure === app) {
    throw new DeployError("SIMULATED_FAILURE", `simulierter Smoke-Fehler für ${APPS[app].name} (--simulate-failure)`);
  }
  if (ctx.smokeTest) await ctx.smokeTest(app, sha, proc);
  else await smoke(ctx, app, sha, proc);
  return { kind: "started", proc };
}

export interface ActivationPlan {
  target: string;
  /** Stand, auf den bei Fehlern zurückgegangen wird (null = erstes Release → gestartete Apps entfernen). */
  fallback: string | null;
  apps: readonly AppKey[];
  envFor: EnvProvider;
  /** Env für den Rückweg (Standard: `envFor`). `deploy:restart` gibt hier die vorherigen Dateien zurück. */
  fallbackEnvFor?: EnvProvider;
}

export class ActivationError extends DeployError {
  readonly reverted: boolean;

  constructor(message: string, reverted: boolean) {
    super("ACTIVATION_FAILED", message);
    this.reverted = reverted;
  }
}

async function checkStable(ctx: DeployContext, started: ReadonlyMap<AppKey, Pm2App>): Promise<void> {
  if (started.size === 0) return;
  await sleep(ctx.settleMs ?? 3_000);
  for (const [app, proc] of started) {
    const now = await findApp(ctx, app);
    if (!now || now.pid !== proc.pid || now.status !== "online") {
      throw new DeployError("APP_UNSTABLE", `${APPS[app].name} ist nach dem Smoke-Test neu gestartet oder abgestürzt`);
    }
  }
  ok("alle gestarteten Apps stabil (keine Neustarts nach dem Smoke-Test)");
}

export async function activate(ctx: DeployContext, plan: ActivationPlan): Promise<void> {
  const touched: AppKey[] = [];
  const started = new Map<AppKey, Pm2App>();
  try {
    switchCurrent(ctx.layout, plan.target);
    ok(`current → releases/${short(plan.target)}`);
    for (const app of plan.apps) {
      touched.push(app);
      const result = await bringUp(ctx, app, plan.target, plan.envFor, true);
      if (result.kind === "skipped") touched.pop();
      if (result.kind === "started") started.set(app, result.proc);
    }
    await checkStable(ctx, started);
  } catch (error) {
    fail(describeError(error));
    const reverted = await revert(ctx, plan, touched);
    throw new ActivationError(
      reverted
        ? `Aktivierung von ${short(plan.target)} fehlgeschlagen, Rückweg erfolgreich – Ursache: ${describeError(error)}`
        : `Aktivierung von ${short(plan.target)} fehlgeschlagen UND Rückweg unvollständig – sofort prüfen: pnpm deploy:status`,
      reverted,
    );
  }
}

async function revert(ctx: DeployContext, plan: ActivationPlan, touched: readonly AppKey[]): Promise<boolean> {
  const fallbackEnv = plan.fallbackEnvFor ?? plan.envFor;
  let clean = true;
  if (plan.fallback === null) {
    step("Rückweg: erstes Release – gestartete Apps werden wieder entfernt");
    for (const app of [...touched].reverse()) {
      try {
        await removeApp(ctx, app, "Erst-Deploy fehlgeschlagen");
      } catch (error) {
        clean = false;
        fail(describeError(error));
      }
    }
    switchCurrent(ctx.layout, null);
    return clean;
  }
  step(`Rückweg auf Release ${short(plan.fallback)}`);
  try {
    switchCurrent(ctx.layout, plan.fallback);
    ok(`current → releases/${short(plan.fallback)}`);
  } catch (error) {
    fail(describeError(error));
    return false;
  }
  for (const app of touched) {
    try {
      await bringUp(ctx, app, plan.fallback, fallbackEnv, false);
    } catch (error) {
      clean = false;
      fail(`Rückweg ${APPS[app].name}: ${describeError(error)}`);
    }
  }
  return clean;
}

/** So viele dump.pm2-Sicherungen bleiben unter backupRoot (sie enthalten die Env aller Apps des Daemons). */
export const KEEP_DUMP_BACKUPS = 20;

export interface PersistResult {
  /** Sicherung des vorherigen dump.pm2 (…/<zeitstempel>/dump.pm2, 600) oder null. */
  backup: string | null;
  merge: DumpMergeResult;
  /** Gelöschte alte Sicherungen. */
  pruned: number;
}

/**
 * Prozessliste speichern: vorheriges dump.pm2 sichern, `pm2 save`, danach alle fremden Einträge auf den vorher
 * gespeicherten Stand zurücksetzen (lib/pm2-dump.ts) – ein Deploy ändert nie, was pm2 beim Boot für andere Apps
 * wiederherstellt. Ist kein gespeicherter Stand lesbar, bleibt der vollständige Save (mit Warnung).
 */
export async function persistProcessList(
  ctx: Pick<DeployContext, "pm2" | "pm2Home" | "backupRoot">,
): Promise<PersistResult> {
  const dump = join(ctx.pm2Home, "dump.pm2");
  const previous: PreviousDump = { dump: readIfExists(dump), bak: readIfExists(`${dump}.bak`) };
  let backup: string | null = null;
  if (previous.dump !== null) {
    const dir = join(ctx.backupRoot, stamp());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    backup = join(dir, "dump.pm2");
    copyFileSync(dump, backup);
    chmodSync(backup, 0o600);
  } else {
    warn(`kein dump.pm2 in ${ctx.pm2Home} – nichts zu sichern`);
  }
  for (const message of await ctx.pm2.save()) info(message);
  const merge = mergeDump(previous, readFileSync(dump, "utf8"), APP_NAMES);
  if (merge.merged) replaceKeepingMode(dump, merge.text);
  const pruned = pruneDumpBackups(ctx.backupRoot, KEEP_DUMP_BACKUPS);
  return { backup, merge, pruned };
}
