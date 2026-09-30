/**
 * Kindprozesse für Deploy und Betrieb: feste Argumentlisten (keine Shell), Zeitlimits und bewusst
 * zusammengestellte Umgebungen. Die Umgebung des Aufrufers wird nie ungefiltert weitergegeben – weder an
 * Builds (keine `npm_*`-Variablen aus `pnpm run`, kein `NEXT_DIST_DIR`) noch an pm2 (dort landet sie sonst
 * in `dump.pm2` und in den Apps).
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { DeployError } from "./log.ts";

/** PATH für pm2 und Systemwerkzeuge: ohne .tooling, damit pm2 auf dem System-Node läuft (wie der Daemon). */
export const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

type Env = Record<string, string | undefined>;

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Sucht ein Programm im PATH (wie `command -v`); absolute Pfade werden nur geprüft. */
export function which(bin: string, pathValue = process.env.PATH ?? ""): string | null {
  if (isAbsolute(bin)) return isExecutable(bin) ? bin : null;
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Variablen, die Builds (pnpm, Next, tsdown) aus der Toolchain-Shell brauchen (`.tooling/activate.sh`). */
const BUILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "NODE_OPTIONS",
  "QM_ROOT",
  "QM_TOOLING",
  "COREPACK_HOME",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  "COREPACK_ENABLE_AUTO_PIN",
  "COREPACK_ENABLE_STRICT",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "npm_config_cache",
] as const;

function pick(source: Env, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Umgebung für Builds und pnpm: Toolchain ja, Secrets/`npm_*`/`NEXT_*`/`MONGODB_*` nein. */
export function buildEnv(source: Env = process.env): Record<string, string> {
  return {
    ...pick(source, BUILD_ENV_KEYS),
    NEXT_TELEMETRY_DISABLED: "1",
    TURBO_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
  };
}

/**
 * Umgebung für pm2-Aufrufe: nur PATH (System), HOME, Sprache und ggf. PM2_HOME. Alles andere würde pm2 in
 * den Prozess-Env der Apps und in `dump.pm2` übernehmen (ecosystem.config.js filtert zusätzlich).
 */
export function pm2Env(source: Env = process.env): Record<string, string> {
  const env: Record<string, string> = {
    PATH: SYSTEM_PATH,
    HOME: source.HOME ?? homedir(),
    LANG: source.LANG ?? "C.UTF-8",
  };
  if (source.PM2_HOME) env.PM2_HOME = source.PM2_HOME;
  return env;
}

export interface RunOptions {
  cwd?: string;
  env: Record<string, string>;
  /** `inherit`: Ausgabe direkt ins Terminal (Build-Logs); `capture`: gepuffert zurückgeben. */
  output?: "inherit" | "capture";
  timeoutMs?: number;
  /**
   * Eigene Prozessgruppe: Strg+C im Terminal erreicht den Kindprozess nicht. Für pm2-Aktionen, die nicht
   * mittendrin abbrechen dürfen (der Deploy entscheidet selbst, wann er aufhört).
   */
  isolate?: boolean;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_CAPTURE = 32 * 1024 * 1024;

export function run(bin: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const capture = options.output === "capture";
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      detached: options.isolate === true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (current: string, chunk: Buffer) =>
      current.length < MAX_CAPTURE ? current + chunk.toString("utf8") : current;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const signalChild = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (options.isolate) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Prozess bereits beendet
      }
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            signalChild("SIGTERM");
            killTimer = setTimeout(() => signalChild("SIGKILL"), 10_000);
          }, options.timeoutMs);
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(new DeployError("SPAWN", `${bin} konnte nicht gestartet werden: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/** Wie `run`, wirft aber bei Exit-Code ≠ 0 bzw. Zeitüberschreitung. `label` erscheint in der Meldung. */
export async function runChecked(
  label: string,
  bin: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const result = await run(bin, args, options);
  if (result.timedOut) throw new DeployError("TIMEOUT", `${label}: Zeitlimit überschritten`);
  if (result.code !== 0) {
    throw new DeployError("COMMAND_FAILED", `${label}: Exit-Code ${result.code ?? result.signal ?? "?"}`);
  }
  return result;
}

/**
 * `producer | consumer` ohne Shell (z. B. `git archive | tar -x`). Beide Exit-Codes müssen 0 sein.
 */
export function pipe(
  producer: { bin: string; args: readonly string[]; cwd?: string },
  consumer: { bin: string; args: readonly string[]; cwd?: string },
  env: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const left = spawn(producer.bin, producer.args, { cwd: producer.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const right = spawn(consumer.bin, consumer.args, { cwd: consumer.cwd, env, stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    left.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    right.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    // EPIPE, falls der Verbraucher vorzeitig endet – der Exit-Code meldet den Fehler.
    right.stdin?.on("error", () => undefined);
    if (right.stdin) left.stdout?.pipe(right.stdin);
    const timer = setTimeout(() => {
      left.kill("SIGKILL");
      right.kill("SIGKILL");
    }, timeoutMs);
    const codes: Array<number | null> = [];
    let failed = false;
    const done = (code: number | null) => {
      codes.push(code);
      if (codes.length < 2 || failed) return;
      clearTimeout(timer);
      if (codes.every((value) => value === 0)) resolvePromise();
      else {
        failed = true;
        const detail = errors.trim().split("\n").slice(-5).join(" | ");
        reject(
          new DeployError(
            "PIPE_FAILED",
            `${producer.bin} | ${consumer.bin} fehlgeschlagen${detail ? ` (${detail})` : ""}`,
          ),
        );
      }
    };
    const onError = (error: Error) => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      reject(new DeployError("SPAWN", error.message));
    };
    left.on("error", onError);
    right.on("error", onError);
    left.on("close", done);
    right.on("close", done);
  });
}

/** Entfernt ANSI-Farbcodes (pm2 färbt trotz --no-color einzelne Zeilen). */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI-Escape-Sequenzen entfernen
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}
