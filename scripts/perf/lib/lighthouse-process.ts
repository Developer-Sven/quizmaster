import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type Options as ChromeOptions, Launcher, type ModuleOverrides } from "chrome-launcher";
import { type LighthouseRun, parseReport } from "./lighthouse.ts";

const MEASUREMENT_TIMEOUT_MS = 4 * 60 * 1_000;
const KILL_GRACE_MS = 5_000;

class LighthouseTimeoutError extends Error {}

export class LighthouseInterruptedError extends Error {
  readonly signal: "SIGINT" | "SIGTERM";

  constructor(signal: "SIGINT" | "SIGTERM") {
    super(`Lighthouse unterbrochen (${signal})`);
    this.signal = signal;
  }
}

export interface LighthouseProcessOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  killGraceMs?: number;
  signal?: AbortSignal;
}

export interface LighthouseProcessResult {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  error: Error | null;
}

export function readLighthouseReport(
  exitCode: number | null,
  page: string,
  url: string,
  reportPath: string,
): LighthouseRun {
  if (exitCode !== 0) {
    return parseReport(page, url, { runtimeError: { code: "LIGHTHOUSE_PROZESS_FEHLGESCHLAGEN" } }, null);
  }
  if (!existsSync(reportPath)) return parseReport(page, url, { runtimeError: { code: "KEIN_BERICHT" } }, null);
  return parseReport(page, url, JSON.parse(readFileSync(reportPath, "utf8")), reportPath);
}

/** Bounds one measurement and cleans up only the process group created for it. */
export function runLighthouseProcess(
  command: string,
  args: readonly string[],
  options: LighthouseProcessOptions,
): Promise<LighthouseProcessResult> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? MEASUREMENT_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  for (const value of [timeoutMs, killGraceMs]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Lighthouse process deadline must be positive");
  }
  return new Promise((resolveRun, rejectRun) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, [...args], {
      env: options.env,
      detached: grouped,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let code: number | null = null;
    let error: Error | null = null;
    let timedOut = false;
    let stopping = false;
    let killed = false;
    let settled = false;
    let closed = false;
    let draining = false;
    let interrupted: LighthouseInterruptedError | null = null;
    let abortFailure: unknown;
    let deadline: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let exitDeadline: NodeJS.Timeout | undefined;

    const finish = (failure?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(exitDeadline);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      options.signal?.removeEventListener("abort", onAbort);
      child.stderr?.destroy();
      child.unref();
      if (failure !== undefined) rejectRun(failure);
      else if (abortFailure !== undefined) rejectRun(abortFailure);
      else if (interrupted !== null) rejectRun(interrupted);
      else resolveRun({ code, stderr, timedOut, error });
    };
    const signal = (value: NodeJS.Signals): boolean => {
      const pid = child.pid;
      if (pid === undefined) return false;
      if (pid <= 1 || pid === process.pid) throw new Error("Invalid Lighthouse child process identity");
      try {
        if (grouped) process.kill(-pid, value);
        else return child.kill(value);
        return true;
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw failure;
      }
    };
    const drain = () => {
      if (draining) return;
      draining = true;
      clearTimeout(exitDeadline);
      if (closed) finish();
      else exitDeadline = setTimeout(() => finish(), 1_000);
    };
    const kill = () => {
      try {
        killed = true;
        signal("SIGKILL");
        if (child.exitCode !== null || child.signalCode !== null || error !== null) drain();
        else exitDeadline = setTimeout(() => finish(new Error("Lighthouse child did not exit after SIGKILL")), 1_000);
      } catch (failure) {
        finish(failure);
      }
    };
    const stop = (expired: boolean) => {
      if (stopping) return;
      stopping = true;
      timedOut = expired;
      clearTimeout(deadline);
      try {
        if (!signal("SIGTERM")) {
          drain();
          return;
        }
        // Keep this timer after the leader exits: a descendant may ignore TERM.
        escalation = setTimeout(kill, killGraceMs);
      } catch (failure) {
        finish(failure);
      }
    };
    const interrupt = (value: "SIGINT" | "SIGTERM") => {
      if (interrupted !== null) {
        clearTimeout(escalation);
        kill();
      } else {
        interrupted = new LighthouseInterruptedError(value);
        stop(false);
      }
    };
    const onInterrupt = () => interrupt("SIGINT");
    const onTerminate = () => interrupt("SIGTERM");
    const onAbort = () => {
      const reason: unknown = options.signal?.reason;
      if (reason instanceof LighthouseInterruptedError) interrupted = reason;
      else if (!(reason instanceof LighthouseTimeoutError)) abortFailure = reason;
      stop(reason instanceof LighthouseTimeoutError);
    };
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
    else {
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onTerminate);
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
    });
    child.once("exit", (exitCode) => {
      code = exitCode;
      if (killed) drain();
      else stop(false);
    });
    child.once("error", (failure) => {
      error = failure;
      stop(false);
    });
    child.once("close", () => {
      closed = true;
      if (draining) finish();
    });
    deadline = setTimeout(() => stop(true), timeoutMs);
  });
}

export interface LighthouseMeasurementOptions extends Omit<LighthouseProcessOptions, "signal"> {
  chromePath: string;
  chromeFlags: readonly string[];
}

export type OwnedBrowser = Pick<Launcher, "launch" | "kill" | "destroyTmp" | "port">;
export type BrowserFactory = (options: ChromeOptions, overrides: ModuleOverrides, signal: AbortSignal) => OwnedBrowser;

function ownedBrowser(options: ChromeOptions, overrides: ModuleOverrides, signal: AbortSignal): OwnedBrowser {
  const browser = new Launcher(options, overrides);
  // The upstream readiness loop has no cancellation; use the same local debug endpoint with bounded waits.
  browser.waitUntilReady = async () => {
    const readyDeadline = Date.now() + 25_000;
    while (Date.now() < readyDeadline) {
      signal.throwIfAborted();
      try {
        const response = await fetch(`http://127.0.0.1:${browser.port}/json/version`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
        });
        const ready = response.ok;
        await response.body?.cancel();
        if (ready) return;
      } catch {
        signal.throwIfAborted();
      }
      await delay(100, undefined, { signal });
    }
    throw new Error("Chrome debug endpoint did not become ready");
  };
  return browser;
}

function untilAborted<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([task, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

async function within<T>(task: Promise<T>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Owns Chrome separately: chrome-launcher creates a different process group from the CLI. */
export async function runLighthouseMeasurement(
  command: string,
  args: readonly string[],
  options: LighthouseMeasurementOptions,
  createBrowser: BrowserFactory = ownedBrowser,
): Promise<LighthouseProcessResult> {
  const duration = options.timeoutMs ?? MEASUREMENT_TIMEOUT_MS;
  const grace = options.killGraceMs ?? KILL_GRACE_MS;
  for (const value of [duration, grace]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Lighthouse measurement deadline must be positive");
  }
  const root = mkdtempSync(join(tmpdir(), "qm-lighthouse-browser-"));
  const sentinel = join(root, "autostart-disabled");
  try {
    writeFileSync(sentinel, "", { mode: 0o600 });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const expires = Date.now() + duration;
  const abort = new AbortController();
  const timeoutError = new LighthouseTimeoutError("Lighthouse measurement deadline exceeded");
  const deadline = setTimeout(() => abort.abort(timeoutError), duration);
  let interrupted: LighthouseInterruptedError | undefined;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    interrupted ??= new LighthouseInterruptedError(signal);
    abort.abort(interrupted);
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  let chrome: ChildProcess | undefined;
  let closing = false;
  let exited: Promise<void> = Promise.resolve();
  const grouped = process.platform !== "win32";
  const signalChrome = (signal: NodeJS.Signals) => {
    const pid = chrome?.pid;
    if (pid === undefined) return;
    if (pid <= 1 || pid === process.pid) throw new Error("Invalid owned Chrome identity");
    try {
      if (grouped) process.kill(-pid, signal);
      else chrome?.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  // chrome-launcher uses this documented three-argument spawn contract.
  const ownedSpawn = ((file: string, argv: readonly string[], spawnOptions: SpawnOptions) => {
    abort.signal.throwIfAborted();
    if (chrome) throw new Error("Chrome instance attempted a second spawn");
    chrome = spawn(file, argv, { ...spawnOptions, detached: grouped });
    exited = new Promise<void>((resolve) => {
      chrome?.once("exit", () => {
        resolve();
        if (!closing) abort.abort(new Error("Owned Chrome exited during measurement"));
      });
      chrome?.once("error", (error) => {
        resolve();
        abort.abort(error);
      });
    });
    return chrome;
  }) as typeof spawn;
  let browser: OwnedBrowser | undefined;
  let result: LighthouseProcessResult | undefined;
  const failures: unknown[] = [];
  try {
    browser = createBrowser(
      {
        chromePath: options.chromePath,
        chromeFlags: [...options.chromeFlags, "--enable-features=DevToolsWebMCPSupport"],
        envVars: options.env,
        handleSIGINT: false,
        port: 0,
      },
      { spawn: ownedSpawn },
      abort.signal,
    );
    await untilAborted(browser.launch(), abort.signal);
    if (!Number.isInteger(browser.port) || (browser.port ?? 0) <= 0) throw new Error("Invalid owned Chrome port");
    result = await runLighthouseProcess(command, [...args, `--port=${browser.port}`], {
      env: { ...options.env, CHROME_PATH: sentinel },
      timeoutMs: Math.max(1, expires - Date.now()),
      killGraceMs: grace,
      signal: abort.signal,
    });
  } catch (error) {
    if (error === timeoutError) result = { code: null, stderr: "", timedOut: true, error: null };
    else failures.push(error);
  } finally {
    closing = true;
    clearTimeout(deadline);
    abort.abort(new Error("Lighthouse measurement finished"));
    if (grouped) {
      try {
        signalChrome("SIGTERM");
      } catch (error) {
        failures.push(error);
      }
      await within(exited, grace);
      try {
        browser?.kill();
      } catch (error) {
        failures.push(error);
      }
      try {
        signalChrome("SIGKILL");
      } catch (error) {
        failures.push(error);
      }
    } else if (chrome?.pid !== undefined && chrome.exitCode === null && chrome.signalCode === null) {
      // Windows needs the live leader for /T; killing it first loses ownership of the tree.
      const killedTree = spawnSync(
        join(process.env.SystemRoot ?? "C:/Windows", "System32", "taskkill.exe"),
        ["/pid", String(chrome.pid), "/T", "/F"],
        { timeout: grace, windowsHide: true, encoding: "utf8" },
      );
      if (killedTree.error) failures.push(killedTree.error);
      else if (killedTree.status !== 0)
        failures.push(new Error(`Owned Chrome tree cleanup failed (${killedTree.status})`));
    }
    if (chrome?.pid !== undefined && chrome.exitCode === null && chrome.signalCode === null) {
      await within(exited, 1_000);
      if (chrome.exitCode === null && chrome.signalCode === null)
        failures.push(new Error("Owned Chrome did not exit after SIGKILL"));
    }
    try {
      browser?.destroyTmp();
    } catch (error) {
      failures.push(error);
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
  if (interrupted && !failures.includes(interrupted)) failures.push(interrupted);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Lighthouse measurement or cleanup failed");
  if (!result) throw new Error("Missing Lighthouse measurement result");
  return result;
}
