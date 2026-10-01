/**
 * Kindprozesse des Test-Stacks: starten (eigene Prozessgruppe, Ausgabe in eine Logdatei), auf Health warten,
 * geordnet stoppen (SIGTERM an die Gruppe, nach Frist SIGKILL) und Ports vorab prüfen. Die Kinder laufen in
 * eigenen Prozessgruppen, damit nur der Stack selbst sie beendet – in der richtigen Reihenfolge und mit
 * anschließendem Aufräumen der Test-Datenbank.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";

export interface ManagedProcess {
  readonly name: string;
  readonly logPath: string;
  readonly child: ChildProcess;
  /** Exit-Code (oder `null` bei Signal), sobald der Prozess beendet ist. */
  readonly exited: Promise<number | null>;
  /** true, solange der Prozess läuft. */
  running(): boolean;
}

export interface StartProcessOptions {
  name: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
}

/** Startet einen Prozess in eigener Prozessgruppe; stdout/stderr gehen in `logPath` (angehängt). */
export function startProcess(options: StartProcessOptions): ManagedProcess {
  const fd = openSync(options.logPath, "a");
  let child: ChildProcess;
  try {
    child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    // Das Kind hat die Datei geerbt; der eigene Deskriptor wird nicht mehr gebraucht.
    closeSync(fd);
  }
  let alive = true;
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => {
      alive = false;
      resolveExit(code);
    });
    child.once("error", (error) => {
      alive = false;
      console.error(`stack:test – ${options.name} nicht startbar: ${error.message}`);
      resolveExit(127);
    });
  });
  return { name: options.name, logPath: options.logPath, child, exited, running: () => alive };
}

/**
 * Signal an die ganze Prozessgruppe des Kindes. `leftovers`: auch nach dem Ende des Gruppenführers (übrig
 * gebliebene Enkelprozesse); sonst nur, solange er läuft.
 */
function signalGroup(proc: ManagedProcess, signal: NodeJS.Signals, leftovers = false): void {
  const pid = proc.child.pid;
  if (pid === undefined || (!leftovers && !proc.running())) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    // ESRCH: Gruppe schon leer – dann ist nichts mehr zu tun; alles andere melden.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      console.error(`stack:test – Signal ${signal} an ${proc.name} fehlgeschlagen: ${(error as Error).message}`);
    }
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ done: false }>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ done: false }), ms);
  });
  return Promise.race([promise.then((value) => ({ done: true as const, value })), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

export type StopResult = "not_running" | "stopped" | "killed";

/** SIGTERM an die Prozessgruppe, nach `timeoutMs` SIGKILL. */
export async function stopProcess(proc: ManagedProcess, timeoutMs: number): Promise<StopResult> {
  if (!proc.running()) {
    signalGroup(proc, "SIGKILL", true);
    return "not_running";
  }
  signalGroup(proc, "SIGTERM");
  const graceful = await within(proc.exited, timeoutMs);
  // Übrig gebliebene Enkelprozesse der Gruppe (falls vorhanden) ebenfalls beenden.
  signalGroup(proc, "SIGKILL", true);
  if (graceful.done) return "stopped";
  await within(proc.exited, 5_000);
  return "killed";
}

/** Sofortiges Beenden (zweites Signal, Abbruch). */
export function killProcess(proc: ManagedProcess): void {
  signalGroup(proc, "SIGKILL", true);
}

/** Wartet auf das Ende eines Prozesses (z. B. Build) und liefert den Exit-Code. */
export async function waitForExit(proc: ManagedProcess): Promise<number | null> {
  return proc.exited;
}

/** Prüft, ob `host:port` frei ist (kurz binden und wieder schließen). */
export function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = createServer();
    server.once("error", () => resolveFree(false));
    server.once("listening", () => server.close(() => resolveFree(true)));
    server.listen(port, host);
  });
}

export interface WaitForHealthOptions {
  url: string;
  timeoutMs: number;
  intervalMs?: number;
  /** Abbruch, sobald der Prozess nicht mehr läuft. */
  proc: ManagedProcess;
  /** Abbruch von außen (Signal während des Starts). */
  aborted: () => boolean;
}

export type HealthResult = "ready" | "exited" | "timeout" | "aborted";

/** Pollt `url`, bis sie 200 mit `{ ok: true }` liefert. */
export async function waitForHealth(options: WaitForHealthOptions): Promise<HealthResult> {
  const deadline = Date.now() + options.timeoutMs;
  const interval = options.intervalMs ?? 300;
  while (Date.now() < deadline) {
    if (options.aborted()) return "aborted";
    if (!options.proc.running()) return "exited";
    try {
      const response = await fetch(options.url, { signal: AbortSignal.timeout(2_000), cache: "no-store" });
      if (response.ok) {
        const body = (await response.json()) as unknown;
        if (typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true) return "ready";
      } else {
        await response.body?.cancel();
      }
    } catch (error) {
      // Noch nicht erreichbar (ECONNREFUSED/Timeout) – beim nächsten Durchlauf erneut versuchen.
      if (!(error instanceof Error)) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, interval));
  }
  return "timeout";
}

/** Letzte `lines` Zeilen einer Logdatei (leer, wenn sie fehlt). */
export function tailFile(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf8").trimEnd();
  return content.split("\n").slice(-lines).join("\n");
}

/** Sucht ein Programm im PATH (ohne Shell). */
export function findExecutable(name: string, pathValue: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Befehl mit niedriger CPU- und IO-Priorität (`nice -n 15 ionice -c3`), sofern beide Programme vorhanden
 * sind (Linux) – schwere Builds sollen Nachbar-Apps auf dem Server nicht ausbremsen.
 */
export function lowPriority(command: string, args: readonly string[]): { command: string; args: string[] } {
  const nice = findExecutable("nice");
  const ionice = findExecutable("ionice");
  if (process.platform !== "linux" || nice === null || ionice === null) return { command, args: [...args] };
  return { command: nice, args: ["-n", "15", ionice, "-c3", command, ...args] };
}
