/**
 * Prozessliste des gemeinsamen pm2-Daemons speichern, ohne die Persistenz fremder Apps zu verändern (ADR-024).
 *
 * `pm2 save` (pm2 6, lib/API/Startup.js `dump`) schreibt den GESAMTEN aktuellen Zustand des Daemons nach
 * dump.pm2, und `pm2 resurrect` (pm2-root.service beim Boot) stellt genau diesen Zustand wieder her – inklusive
 * Status `stopped`. Eine fremde App, die während eines Deploys gerade manuell gestoppt, probeweise gestartet
 * oder gelöscht ist, bliebe sonst nach dem nächsten Reboot so. Deshalb: nach dem Save alle fremden Einträge
 * durch den vorher gespeicherten Stand ersetzen; nur die Einträge von quizmaster-* stammen aus dem neuen Stand.
 *
 * Fremde Einträge enthalten die Env anderer Apps (Secrets) – sie werden nur unverändert kopiert, Berichte
 * nennen ausschließlich Namen und Status.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

type DumpEntry = Record<string, unknown>;

/** Gespeicherter Stand vor dem Save: dump.pm2 und dump.pm2.bak (Inhalt oder null, falls nicht vorhanden). */
export interface PreviousDump {
  dump: string | null;
  bak: string | null;
}

export type DumpMergeResult =
  | {
      merged: true;
      text: string;
      /** Übernommene fremde Einträge aus dem gespeicherten Stand. */
      keptForeign: number;
      /** quizmaster-Einträge aus dem neuen Stand. */
      ours: number;
      /** Fremde Apps, deren aktueller Zustand vom gespeicherten abweicht (nur Name/Status – bleibt unverändert). */
      drift: string[];
    }
  | { merged: false; reason: string };

/** JSON-Liste von Objekten (Format von dump.pm2) oder null, wenn unlesbar. */
export function parseDump(text: string | null): DumpEntry[] | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    return null;
  }
  return raw as DumpEntry[];
}

const nameOf = (entry: DumpEntry): string | null => (typeof entry.name === "string" ? entry.name : null);
const statusOf = (entry: DumpEntry): string => (typeof entry.status === "string" ? entry.status : "?");

function statusByName(entries: readonly DumpEntry[]): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const name = nameOf(entry);
    if (name === null) continue;
    grouped.set(name, [...(grouped.get(name) ?? []), statusOf(entry)]);
  }
  return new Map([...grouped].map(([name, statuses]) => [name, statuses.sort().join("+")]));
}

/**
 * Führt den gespeicherten Stand (fremde Apps) und den neuen Stand von `pm2 save` (nur `ours`) zusammen.
 * Gespeicherter Stand wie bei `pm2 resurrect`: dump.pm2, falls lesbar, sonst dump.pm2.bak; existiert keine
 * der beiden Dateien, waren fremde Apps nie persistiert (bleibt so).
 */
export function mergeDump(previous: PreviousDump, saved: string, ours: readonly string[]): DumpMergeResult {
  const current = parseDump(saved);
  if (current === null) return { merged: false, reason: "neues dump.pm2 ist nicht lesbar" };
  let base: DumpEntry[];
  if (previous.dump === null && previous.bak === null) base = [];
  else {
    const parsed = parseDump(previous.dump) ?? parseDump(previous.bak);
    if (parsed === null) return { merged: false, reason: "vorheriges dump.pm2 und dump.pm2.bak sind nicht lesbar" };
    base = parsed;
  }
  const isOurs = (entry: DumpEntry) => {
    const name = nameOf(entry);
    return name !== null && ours.includes(name);
  };
  const foreign = base.filter((entry) => !isOurs(entry));
  const fresh = current.filter(isOurs);

  const before = statusByName(foreign);
  const now = statusByName(current.filter((entry) => !isOurs(entry)));
  const drift: string[] = [];
  for (const [name, status] of now) {
    const old = before.get(name);
    if (old === undefined) drift.push(`${name}: läuft, war aber nicht gespeichert – bleibt ungespeichert`);
    else if (old !== status) drift.push(`${name}: ${old} gespeichert, jetzt ${status} – gespeicherter Zustand bleibt`);
  }
  for (const name of before.keys()) {
    if (!now.has(name)) drift.push(`${name}: nicht mehr im Daemon – gespeicherter Eintrag bleibt`);
  }
  return {
    merged: true,
    text: JSON.stringify([...foreign, ...fresh], null, 2),
    keptForeign: foreign.length,
    ours: fresh.length,
    drift,
  };
}

/** Inhalt einer Datei oder null, falls sie nicht existiert. */
export function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Ersetzt `path` atomar (temporäre Datei daneben, fsync, rename) und behält die Rechte der bisherigen Datei. */
export function replaceKeepingMode(path: string, content: string): void {
  const mode = statSync(path).mode & 0o777;
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Sicherungsordner des Deploys (log.ts `stamp`, ggf. mit PID-Suffix wie in infra/ops/lib.sh). */
const BACKUP_STAMP = /^\d{8}-\d{6}(?:-\d+)?$/;

/**
 * Löscht alte dump.pm2-Sicherungen unter `root/<zeitstempel>/dump.pm2` (die neuesten `keep` bleiben). Andere
 * Sicherungen im selben Ordner (Caddy, Cron) bleiben unberührt; leere Zeitstempel-Ordner werden entfernt.
 */
export function pruneDumpBackups(root: string, keep: number): number {
  if (!existsSync(root)) return 0;
  const stamps = readdirSync(root)
    .filter((name) => BACKUP_STAMP.test(name) && existsSync(join(root, name, "dump.pm2")))
    .sort()
    .reverse();
  let removed = 0;
  for (const stamp of stamps.slice(keep)) {
    rmSync(join(root, stamp, "dump.pm2"), { force: true });
    removed += 1;
    if (readdirSync(join(root, stamp)).length === 0) rmdirSync(join(root, stamp));
  }
  return removed;
}
