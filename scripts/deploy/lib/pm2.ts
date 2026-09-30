/**
 * pm2-Anbindung des Deploys (ADR-024): immer mit bereinigter Umgebung (`pm2Env`) und nur für die Apps
 * `quizmaster-*`. `pm2 jlist` enthält die Env ALLER Apps des Daemons (auch fremder Apps mit Secrets) – die
 * Ausgabe wird nur im Speicher ausgewertet, nie ausgegeben, und Parserfehler zeigen keinen Ausschnitt.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeployError } from "./log.ts";
import { type RunResult, run, stripAnsi } from "./proc.ts";

export interface Pm2App {
  name: string;
  pid: number;
  status: string;
  restarts: number;
  /** Startzeitpunkt (ms seit Epoch) des aktuellen Prozesses. */
  startedAt: number | null;
  memoryBytes: number | null;
  cpuPercent: number | null;
}

/** Wertet `pm2 jlist` aus – nur die gewünschten Apps, nur unkritische Felder. */
export function parseJlist(stdout: string, names: readonly string[]): Pm2App[] {
  // pm2 kann Warnzeilen voranstellen (z. B. „[PM2][WARN] …“); die Liste beginnt mit „[{“ bzw. ist „[]“.
  const match = /(^|\n)\s*(\[\{|\[\s*\])/.exec(stdout);
  const start = match ? match.index + match[0].length - (match[2] ?? "").length : -1;
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end < start) throw new DeployError("PM2_JLIST", "pm2 jlist lieferte keine Prozessliste");
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    // Bewusst ohne Ausschnitt: die Ausgabe kann Env-Werte anderer Apps enthalten.
    throw new DeployError("PM2_JLIST", "pm2 jlist lieferte kein gültiges JSON");
  }
  if (!Array.isArray(raw)) throw new DeployError("PM2_JLIST", "pm2 jlist lieferte keine Liste");
  const wanted = new Set(names);
  const apps: Pm2App[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : null;
    if (name === null || !wanted.has(name)) continue;
    const env = (typeof record.pm2_env === "object" && record.pm2_env !== null ? record.pm2_env : {}) as Record<
      string,
      unknown
    >;
    const monit = (typeof record.monit === "object" && record.monit !== null ? record.monit : {}) as Record<
      string,
      unknown
    >;
    apps.push({
      name,
      pid: typeof record.pid === "number" ? record.pid : 0,
      status: typeof env.status === "string" ? env.status : "unknown",
      restarts: typeof env.restart_time === "number" ? env.restart_time : 0,
      startedAt: typeof env.pm_uptime === "number" ? env.pm_uptime : null,
      memoryBytes: typeof monit.memory === "number" ? monit.memory : null,
      cpuPercent: typeof monit.cpu === "number" ? monit.cpu : null,
    });
  }
  return apps;
}

/** PM2_HOME wie der pm2-CLI: Umgebung, sonst ~/.pm2. */
export function pm2Home(env: Record<string, string | undefined> = process.env): string {
  return env.PM2_HOME && env.PM2_HOME !== "" ? env.PM2_HOME : join(env.HOME ?? homedir(), ".pm2");
}

/** Läuft der Daemon dieses PM2_HOME? (pid-Datei + Prozess), ohne pm2 aufzurufen (das würde ihn starten). */
export function daemonAlive(home: string): boolean {
  const pidFile = join(home, "pm2.pid");
  if (!existsSync(pidFile)) return false;
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Nur die Statuszeilen von pm2 (`[PM2] …`), ohne Tabellen mit fremden Apps. */
export function pm2Messages(result: RunResult): string[] {
  return stripAnsi(`${result.stdout}\n${result.stderr}`)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("[PM2"));
}

export interface Pm2Client {
  list(names: readonly string[]): Promise<Pm2App[]>;
  startOrReload(name: string): Promise<string[]>;
  remove(name: string): Promise<string[]>;
  save(): Promise<string[]>;
}

export function createPm2(options: { bin: string; env: Record<string, string>; ecosystem: string }): Pm2Client {
  const call = async (label: string, args: string[], timeoutMs: number): Promise<string[]> => {
    const result = await run(options.bin, ["--no-color", ...args], {
      env: options.env,
      output: "capture",
      timeoutMs,
      isolate: true,
    });
    const messages = pm2Messages(result);
    if (result.timedOut) throw new DeployError("PM2_TIMEOUT", `pm2 ${label}: Zeitlimit überschritten`);
    if (result.code !== 0) {
      throw new DeployError("PM2_FAILED", `pm2 ${label} (Exit ${result.code ?? "?"}): ${messages.join(" | ")}`);
    }
    return messages;
  };
  return {
    async list(names) {
      const result = await run(options.bin, ["jlist"], {
        env: options.env,
        output: "capture",
        timeoutMs: 30_000,
        isolate: true,
      });
      if (result.code !== 0 || result.timedOut) throw new DeployError("PM2_JLIST", "pm2 jlist fehlgeschlagen");
      return parseJlist(result.stdout, names);
    },
    // Reload im Fork-Modus = Neustart; pm2 übernimmt dabei die aktuelle Definition aus der Ecosystem-Datei.
    startOrReload: (name) =>
      call(`startOrReload ${name}`, ["startOrReload", options.ecosystem, "--only", name], 120_000),
    remove: (name) => call(`delete ${name}`, ["delete", name], 60_000),
    save: () => call("save", ["save"], 60_000),
  };
}
