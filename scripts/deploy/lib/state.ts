/**
 * `.deploy/state.json`: Rollback-Stapel und Historie (ADR-025).
 *
 * - `stack`: erfolgreiche Aktivierungen, neueste zuletzt. Oben liegt das laufende Release, darunter das
 *   vorherige. `deploy:rollback` nimmt das oberste ab (geht also schrittweise zurück); ein Deploy legt auf.
 * - `history`: jede Aktion mit Ergebnis (nur SHAs, Zeitpunkte, Fehlercodes – keine Werte).
 */
import { existsSync, readFileSync } from "node:fs";
import { writePrivateFile } from "./envfiles.ts";
import { SHA_PATTERN } from "./layout.ts";
import { DeployError } from "./log.ts";

export interface Activation {
  sha: string;
  at: string;
}

export type Action = "deploy" | "rollback" | "restart";
export type Outcome = "ok" | "rolled_back" | "failed";

export interface HistoryEntry {
  at: string;
  action: Action;
  sha: string;
  from: string | null;
  result: Outcome;
  message?: string;
}

export interface DeployState {
  version: 1;
  stack: Activation[];
  history: HistoryEntry[];
}

const MAX_STACK = 20;
const MAX_HISTORY = 100;

export function emptyState(): DeployState {
  return { version: 1, stack: [], history: [] };
}

function isActivation(value: unknown): value is Activation {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.sha === "string" && SHA_PATTERN.test(entry.sha) && typeof entry.at === "string";
}

export function parseState(text: string): DeployState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DeployError("STATE_CORRUPT", "state.json ist kein gültiges JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new DeployError("STATE_CORRUPT", "state.json: Objekt erwartet");
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.stack) || !Array.isArray(record.history)) {
    throw new DeployError("STATE_CORRUPT", "state.json: unbekanntes Format");
  }
  if (!record.stack.every(isActivation)) throw new DeployError("STATE_CORRUPT", "state.json: ungültiger Stapel");
  return { version: 1, stack: record.stack, history: record.history as HistoryEntry[] };
}

export function readState(file: string): DeployState {
  if (!existsSync(file)) return emptyState();
  return parseState(readFileSync(file, "utf8"));
}

export function writeState(file: string, state: DeployState): void {
  writePrivateFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function currentOf(state: DeployState): string | null {
  return state.stack.at(-1)?.sha ?? null;
}

export function previousOf(state: DeployState): string | null {
  return state.stack.at(-2)?.sha ?? null;
}

/** Erfolgreiche Aktivierung von `sha` oben auflegen (gleiches SHA oben: nur Zeitpunkt aktualisieren). */
export function pushActivation(state: DeployState, sha: string, at: string): DeployState {
  const stack = [...state.stack];
  if (stack.at(-1)?.sha === sha) stack[stack.length - 1] = { sha, at };
  else stack.push({ sha, at });
  return { ...state, stack: stack.slice(-MAX_STACK) };
}

/** Oberstes Release abnehmen (Rollback); liefert das neue oberste = Ziel des Rollbacks. */
export function popActivation(state: DeployState): { target: string; state: DeployState } {
  if (state.stack.length < 2) {
    throw new DeployError("NO_PREVIOUS_RELEASE", "kein vorheriges Release im Rollback-Stapel");
  }
  const stack = state.stack.slice(0, -1);
  const target = stack.at(-1);
  if (!target) throw new DeployError("NO_PREVIOUS_RELEASE", "kein vorheriges Release im Rollback-Stapel");
  return { target: target.sha, state: { ...state, stack } };
}

export function addHistory(state: DeployState, entry: HistoryEntry): DeployState {
  return { ...state, history: [...state.history, entry].slice(-MAX_HISTORY) };
}

/** Stapeleinträge ohne vorhandenes Release-Verzeichnis entfernen (z. B. von Hand gelöscht). */
export function pruneStack(state: DeployState, existing: ReadonlySet<string>): DeployState {
  return { ...state, stack: state.stack.filter((entry) => existing.has(entry.sha)) };
}

/**
 * Welche Release-Verzeichnisse gelöscht werden: behalten werden die `keep` jüngsten verschiedenen
 * Releases des Stapels (aktuelles + vorherige) sowie alles in `protect` (z. B. das laufende Release).
 */
export function releasesToDelete(
  state: DeployState,
  releases: readonly string[],
  keep: number,
  protect: ReadonlySet<string> = new Set(),
): string[] {
  const newestFirst: string[] = [];
  for (let index = state.stack.length - 1; index >= 0; index--) {
    const sha = state.stack[index]?.sha;
    if (sha !== undefined && !newestFirst.includes(sha)) newestFirst.push(sha);
  }
  const keepSet = new Set<string>([...protect, ...newestFirst.slice(0, keep)]);
  return releases.filter((sha) => !keepSet.has(sha));
}
