// pnpm perf:lighthouse [--runs 3] [--warn-only] [--web-dir apps/web] [--dist-dir .next] [--realtime-entry <pfad>]
// pnpm perf:lighthouse --url https://<host> [--resolve <host>=<ip>] [--insecure] [--lobby-code ABC234]
//
// Lighthouse mobil (docs/07 §SLOs, docs/11 §CI Schritt 7, ADR-027/031) für Start- und Lobby-Seite: Performance ≥ 90,
// Accessibility ≥ 95, Best Practices ≥ 95; dazu LCP, CLS und TBT. Chromium aus PLAYWRIGHT_BROWSERS_PATH (bzw.
// CHROME_PATH), `--headless=new --no-sandbox`, mobile Standard-Drosselung, Median aus --runs Läufen je Seite.
//
// Ohne --url: eigener Test-Stack aus dem Prod-Build (Test-DB mit Präfix + Fixtures, Realtime dist/index.mjs, Web
// `next start` aus --dist-dir) auf 127.0.0.1:--web-port/--realtime-port (Standard 3520/4520).
// Mit --url: gegen eine laufende Instanz, z. B. Produktion über den Origin:
//   --resolve quiz.example=203.0.113.7 (Chromium --host-resolver-rules) und --insecure (Origin-Zertifikat).
// Berichte (JSON + HTML) und Zusammenfassung nach reports/lighthouse/<zeit>/.
// Exit 1 bei Unterschreitung (mit --warn-only nur Warnungen, Exit 0), Exit 2 bei Aufruf-/Startfehlern.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { FIXTURES_CONTENT_DIR } from "../content/lib/paths.ts";
import { prepareSeed, runSeed } from "../content/lib/seed-runner.ts";
import {
  isPortFree,
  type ManagedProcess,
  startProcess,
  stopProcess,
  tailFile,
  waitForHealth,
} from "../dev/lib/processes.ts";
import { createStackSecrets, realtimeStackEnv, redactSecrets, webStackEnv } from "../dev/lib/stack-config.ts";
import {
  findChromium,
  LIGHTHOUSE_THRESHOLDS,
  type LighthouseRun,
  lighthouseArgs,
  medianRun,
  parseReport,
  parseResolve,
  VITALS_TARGETS,
  violations,
} from "./lib/lighthouse.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const LIGHTHOUSE_CLI = join(REPO_ROOT, "scripts", "node_modules", "lighthouse", "cli", "index.js");
const USAGE = `pnpm perf:lighthouse [--runs 3] [--warn-only] [--web-dir <pfad>] [--dist-dir .next] [--realtime-entry <pfad>]
  [--web-port 3520] [--realtime-port 4520] | --url <https-url> [--resolve <host>=<ip>] [--insecure] [--lobby-code ABC234]`;

class UsageError extends Error {}

const log = (line: string) => console.info(`perf:lighthouse – ${line}`);

interface Stack {
  base: string;
  stop(): Promise<void>;
}

async function startStack(options: {
  webDir: string;
  distDir: string;
  realtimeEntry: string;
  webPort: number;
  realtimePort: number;
  logDir: string;
}): Promise<Stack> {
  if (!existsSync(join(options.webDir, options.distDir, "BUILD_ID"))) {
    throw new UsageError(`${join(options.webDir, options.distDir)} ohne Build – erst pnpm build (bzw. --dist-dir)`);
  }
  if (!existsSync(options.realtimeEntry)) throw new UsageError(`${options.realtimeEntry} fehlt – erst pnpm build`);
  for (const port of [options.webPort, options.realtimePort]) {
    if (!(await isPortFree(port, "127.0.0.1"))) throw new UsageError(`Port ${port} ist belegt`);
  }
  const database: TestDatabase = await createTestDatabase({ appName: "quizmaster-lighthouse" });
  const sensitive = [database.uri];
  const processes: ManagedProcess[] = [];
  const stop = async () => {
    for (const proc of [...processes].reverse()) await stopProcess(proc, 15_000);
    await database.cleanup();
  };
  try {
    const seedOptions = { env: "dev" as const, contentDir: FIXTURES_CONTENT_DIR, prefix: database.prefix };
    await runSeed(
      database.db,
      { ...seedOptions, dryRun: false, allowMassRetire: false },
      prepareSeed(seedOptions, database.dbName),
    );
    const secrets = createStackSecrets();
    sensitive.push(...Object.values(secrets));
    const input = {
      parent: process.env,
      ports: { webPort: options.webPort, realtimePort: options.realtimePort },
      database: { uri: database.uri, dbName: database.dbName, prefix: database.prefix },
      secrets,
      logLevel: "warn" as const,
    };
    const realtime = startProcess({
      name: "realtime",
      command: process.execPath,
      args: [options.realtimeEntry],
      cwd: resolve(options.realtimeEntry, "..", ".."),
      env: realtimeStackEnv(input),
      logPath: join(options.logDir, "realtime.log"),
    });
    processes.push(realtime);
    const realtimeUrl = `http://127.0.0.1:${options.realtimePort}`;
    if (
      (await waitForHealth({
        url: `${realtimeUrl}/healthz`,
        timeoutMs: 60_000,
        proc: realtime,
        aborted: () => false,
      })) !== "ready"
    ) {
      throw new Error(`Realtime nicht bereit:\n${redactSecrets(tailFile(realtime.logPath, 20), sensitive)}`);
    }
    // Wie in Produktion: kein Dev-Bot-Knopf, normale Seiten (GAME_TIMING spielt für Lighthouse keine Rolle).
    const web = startProcess({
      name: "web",
      command: process.execPath,
      args: [
        join(options.webDir, "node_modules/next/dist/bin/next"),
        "start",
        "-H",
        "127.0.0.1",
        "-p",
        String(options.webPort),
      ],
      cwd: options.webDir,
      env: { ...webStackEnv(input), NEXT_DIST_DIR: options.distDir, DEV_BOTS_ENABLED: "false" },
      logPath: join(options.logDir, "web.log"),
    });
    processes.push(web);
    const base = `http://127.0.0.1:${options.webPort}`;
    if (
      (await waitForHealth({ url: `${base}/api/health`, timeoutMs: 90_000, proc: web, aborted: () => false })) !==
      "ready"
    ) {
      throw new Error(`Web nicht bereit:\n${redactSecrets(tailFile(web.logPath, 20), sensitive)}`);
    }
    log(`Stack bereit: ${base} (Realtime ${realtimeUrl}, Test-DB-Präfix ${database.prefix})`);
    return { base, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

function runLighthouse(url: string, outputBase: string, args: string[], chrome: string): Promise<number | null> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [LIGHTHOUSE_CLI, ...args], {
      env: { ...process.env, CHROME_PATH: chrome },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
    });
    child.on("exit", (code) => {
      if (code !== 0) log(`Lighthouse ${new URL(url).pathname}: Exit ${code}\n${stderr.trim().slice(-1_000)}`);
      resolveRun(code);
    });
    child.on("error", (error) => {
      log(`Lighthouse nicht startbar: ${error.message} (${outputBase})`);
      resolveRun(null);
    });
  });
}

const percent = (score: number | null) => (score === null ? "–" : String(Math.round(score * 100)));
const seconds = (value: number | null) => (value === null ? "–" : `${(value / 1_000).toFixed(2).replace(".", ",")} s`);

function summaryMarkdown(results: readonly LighthouseRun[], runs: number, base: string): string {
  const lines = [
    `Lighthouse ${new Date().toISOString()} · ${base} · mobil (simuliertes langsames 4G) · Median aus ${runs} Lauf/Läufen`,
    "",
    "| Seite | Performance | Accessibility | Best Practices | LCP | CLS | TBT | FCP | Endadresse |",
    "|---|---|---|---|---|---|---|---|---|",
    ...results.map(
      (run) =>
        `| ${run.page} | ${percent(run.scores.performance)} | ${percent(run.scores.accessibility)} | ${percent(run.scores["best-practices"])} | ${seconds(run.lcpMs)} | ${run.cls === null ? "–" : run.cls.toFixed(3)} | ${run.tbtMs === null ? "–" : `${Math.round(run.tbtMs)} ms`} | ${seconds(run.fcpMs)} | ${run.finalUrl === null ? "–" : new URL(run.finalUrl).pathname} |`,
    ),
    "",
    `Mindestwerte: Performance ≥ ${LIGHTHOUSE_THRESHOLDS.performance * 100}, Accessibility ≥ ${LIGHTHOUSE_THRESHOLDS.accessibility * 100}, Best Practices ≥ ${LIGHTHOUSE_THRESHOLDS["best-practices"] * 100}; Richtwerte LCP < ${VITALS_TARGETS.lcpMs / 1_000} s, CLS < ${VITALS_TARGETS.cls}.`,
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      resolve: { type: "string" },
      insecure: { type: "boolean" },
      "lobby-code": { type: "string" },
      runs: { type: "string" },
      "warn-only": { type: "boolean" },
      "web-dir": { type: "string" },
      "dist-dir": { type: "string" },
      "realtime-entry": { type: "string" },
      "web-port": { type: "string" },
      "realtime-port": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.info(`Aufruf: ${USAGE}`);
    return 0;
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const absolute = (path: string) => (isAbsolute(path) ? path : resolve(cwd, path));
  const runs = Number(values.runs ?? "3");
  if (!Number.isInteger(runs) || runs < 1 || runs > 9) throw new UsageError("--runs: 1–9");
  const lobbyCode = (values["lobby-code"] ?? "ABC234").toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(lobbyCode)) throw new UsageError("--lobby-code: 6 Zeichen aus dem Code-Alphabet");
  const chrome = findChromium(process.env);
  if (chrome === null) {
    throw new UsageError(
      "Chromium fehlt: CHROME_PATH setzen oder pnpm --filter @quizmaster/e2e exec playwright install chromium",
    );
  }
  if (!existsSync(LIGHTHOUSE_CLI)) throw new UsageError("lighthouse fehlt (scripts/node_modules) – pnpm install");
  const port = (raw: string | undefined, fallback: number) => {
    const value = Number(raw ?? fallback);
    if (!Number.isInteger(value) || value < 1_024 || value > 65_535) throw new UsageError("Port 1024–65535 erwartet");
    return value;
  };

  const runDir = join(REPO_ROOT, "reports", "lighthouse", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
  mkdirSync(runDir, { recursive: true });
  let stack: Stack | null = null;
  let base: string;
  if (values.url !== undefined) {
    const url = new URL(values.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError("--url: http(s) erwartet");
    base = url.origin;
  } else {
    if (values.resolve !== undefined || values.insecure) throw new UsageError("--resolve/--insecure nur mit --url");
    stack = await startStack({
      webDir: absolute(values["web-dir"] ?? join(REPO_ROOT, "apps", "web")),
      distDir: values["dist-dir"] ?? process.env.NEXT_DIST_DIR ?? ".next",
      realtimeEntry: absolute(values["realtime-entry"] ?? join(REPO_ROOT, "apps", "realtime", "dist", "index.mjs")),
      webPort: port(values["web-port"], 3_520),
      realtimePort: port(values["realtime-port"], 4_520),
      logDir: runDir,
    });
    base = stack.base;
  }
  const chromeOptions = {
    resolve: values.resolve === undefined ? null : parseResolve(values.resolve),
    insecure: values.insecure === true,
  };
  if (chromeOptions.resolve !== null && new URL(base).hostname !== chromeOptions.resolve.host) {
    throw new UsageError("--resolve: Host muss dem Host aus --url entsprechen");
  }
  if (chromeOptions.insecure) log("--insecure: Zertifikatsfehler werden ignoriert (nur für Origin-Zertifikate)");

  const pages = [
    { page: "Start /", path: "/" },
    { page: `Lobby /lobby/${lobbyCode}`, path: `/lobby/${lobbyCode}` },
  ];
  const medians: LighthouseRun[] = [];
  try {
    for (const target of pages) {
      const url = new URL(target.path, base).href;
      const all: LighthouseRun[] = [];
      for (let index = 1; index <= runs; index++) {
        const slug = target.path === "/" ? "start" : "lobby";
        const outputBase = join(runDir, `${slug}-${index}`);
        await runLighthouse(url, outputBase, lighthouseArgs(url, outputBase, chromeOptions), chrome);
        const reportPath = `${outputBase}.report.json`;
        if (!existsSync(reportPath)) {
          all.push(parseReport(target.page, url, { runtimeError: { code: "KEIN_BERICHT" } }, null));
          continue;
        }
        const run = parseReport(target.page, url, JSON.parse(readFileSync(reportPath, "utf8")), reportPath);
        all.push(run);
        log(
          `${target.page} #${index}: P ${percent(run.scores.performance)} · A11y ${percent(run.scores.accessibility)} · BP ${percent(run.scores["best-practices"])} · LCP ${seconds(run.lcpMs)} · CLS ${run.cls?.toFixed(3) ?? "–"} · TBT ${run.tbtMs === null ? "–" : Math.round(run.tbtMs)} ms`,
        );
      }
      const median = medianRun(all);
      if (median !== null) medians.push(median);
    }
  } finally {
    await stack?.stop();
  }

  const markdown = summaryMarkdown(medians, runs, stack === null ? base : "lokaler Prod-Build");
  writeFileSync(join(runDir, "summary.md"), markdown);
  writeFileSync(
    join(runDir, "summary.json"),
    `${JSON.stringify({ base: stack === null ? base : "lokal", runs, medians }, null, 2)}\n`,
  );
  console.info(`\n${markdown}`);
  for (const run of medians) {
    if (run.failedAudits.length > 0) log(`${run.page} – nicht bestandene Audits: ${run.failedAudits.join(", ")}`);
    if ((run.lcpMs ?? 0) > VITALS_TARGETS.lcpMs) log(`${run.page}: LCP über dem Richtwert ${VITALS_TARGETS.lcpMs} ms`);
    if ((run.cls ?? 0) > VITALS_TARGETS.cls) log(`${run.page}: CLS über dem Richtwert ${VITALS_TARGETS.cls}`);
  }
  log(`Berichte: ${runDir}`);
  const problems = medians.flatMap(violations);
  if (medians.length < pages.length) problems.push("nicht jede Seite gemessen");
  if (problems.length === 0) {
    log("Alle Mindestwerte erreicht.");
    return 0;
  }
  for (const problem of problems) {
    // GitHub-Annotation (in der CI sichtbar), lokal gut lesbar.
    console.info(`${values["warn-only"] ? "::warning::" : "::error::"}Lighthouse ${problem}`);
  }
  return values["warn-only"] ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`perf:lighthouse – ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) console.error(`Aufruf: ${USAGE}`);
    process.exit(2);
  },
);
