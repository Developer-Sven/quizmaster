/**
 * Rechte für den Dienstbenutzer (docs/12 „Nicht-Root-User“, README „Systembenutzer“). Der Deploy läuft als root,
 * die Apps mit uid/gid aus ecosystem.config.js (scripts/deploy/service-user.cjs). Vor jeder Aktivierung gilt:
 *
 *   .deploy (Testmodus zusätzlich .deploy/test)   0711 root – durchsuchbar, nicht auflistbar, nicht beschreibbar
 *   .deploy/env                                   0750 root:<gruppe>, Env-Dateien 0640 root:<gruppe>
 *   .deploy/releases                              0750 root:<gruppe> – das Build-Ergebnis enthält Schlüssel von
 *                                                 Next.js (Preview-Modus, Server Actions): nur für die Gruppe
 *   releases/<sha>/web/apps/web/.next/cache       0700 <benutzer>:<gruppe> – die einzige beschreibbare Stelle
 *   Releases und Node-Laufzeit                    für den Benutzer lesbar, nicht beschreibbar (wird geprüft)
 *
 * Ohne Dienstbenutzer (Rückfall root): Env 0700/0600 root wie vor der Umstellung, `.deploy/releases` 0700 root,
 * `.next/cache` gehört root. Bäume, in die der Dienstbenutzer schreiben kann, löscht der Deploy nur mit
 * `rm -rf --one-file-system` (GNU coreutils, sicher gegen Symlink-Wettläufe) – nie mit einer eigenen
 * rekursiven Schleife als root.
 *
 * Die Prüfungen werten die Rechte-Bits so aus wie der Kernel für einen Prozess mit genau dieser uid/gid ohne
 * Zusatzgruppen (pm2/libuv verwerfen sie beim Start): Besitzer vor Gruppe vor andere; ACLs werden nicht gesetzt.
 */
import {
  chmodSync,
  chownSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseGroup, parsePasswd, type ServiceIdentity } from "../service-user.cjs";
import type { FileAccess } from "./envfiles.ts";
import { APP_KEYS, envFile, type Layout, releaseDir } from "./layout.ts";
import { DeployError, short } from "./log.ts";
import { run, SYSTEM_PATH } from "./proc.ts";

/** Prozess-Identität ohne Zusatzgruppen (so startet pm2 die Apps). */
export interface ProcessIdentity {
  uid: number;
  gid: number;
}

export const DEPLOY_DIR_MODE = 0o711;
export const CACHE_DIR_MODE = 0o700;
const ENV_MODES = { service: { dir: 0o750, file: 0o640 }, root: { dir: 0o700, file: 0o600 } } as const;
/** `.deploy/releases`: nur Gruppe des Dienstbenutzers bzw. nur root (Schlüssel im Next-Build). */
const RELEASES_MODES = { service: 0o750, root: 0o700 } as const;

/** Rechte-Bits (wie in `mode`): lesen, schreiben, ausführen bzw. durchsuchen. */
export const R = 4;
export const W = 2;
export const X = 1;

/** Rechte als vierstellige Oktalzahl („0640“). */
function octal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/** Benutzer des Deploys (in Produktion root) – gehört alles, was nicht dem Dienstbenutzer gehört. */
export function deployIdentity(): ProcessIdentity {
  return { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
}

/** Identität der App-Prozesse: Dienstbenutzer oder (Rückfall) der Benutzer des Deploys bzw. pm2-Daemons. */
export function appIdentity(identity: ServiceIdentity): ProcessIdentity {
  return identity.kind === "service" ? { uid: identity.uid, gid: identity.gid } : deployIdentity();
}

/** Besitz und Rechte der Env-Dateien und ihres Verzeichnisses. */
export function envAccess(identity: ServiceIdentity): FileAccess {
  const owner = deployIdentity();
  const modes = identity.kind === "service" ? ENV_MODES.service : ENV_MODES.root;
  return {
    uid: owner.uid,
    gid: identity.kind === "service" ? identity.gid : owner.gid,
    dirMode: modes.dir,
    fileMode: modes.file,
  };
}

/** „quizmaster (uid 998, gid 998 quizmaster)“ bzw. „root (Rückfall: …)“ – für Ausgaben. */
export function describeIdentity(identity: ServiceIdentity): string {
  return identity.kind === "service"
    ? `${identity.user} (uid ${identity.uid}, gid ${identity.gid} ${identity.group})`
    : `root (Rückfall: ${identity.reason})`;
}

// ── Rechte-Auswertung ───────────────────────────────────────────────────────────────────────────

interface Owned {
  uid: number;
  gid: number;
  mode: number;
}

/** Rechte-Bits (0–7), die für `who` an einem Objekt gelten; root darf alles (CAP_DAC_OVERRIDE). */
export function bitsFor(stat: Owned, who: ProcessIdentity): number {
  if (who.uid === 0) return 7;
  if (stat.uid === who.uid) return (stat.mode >> 6) & 7;
  if (stat.gid === who.gid) return (stat.mode >> 3) & 7;
  return stat.mode & 7;
}

export function permits(stat: Owned, who: ProcessIdentity, want: number): boolean {
  return (bitsFor(stat, who) & want) === want;
}

/** Kann `who` das Objekt verändern – als Besitzer (chmod) oder über ein Schreibrecht? */
export function canModify(stat: Owned, who: ProcessIdentity): boolean {
  return who.uid === 0 || stat.uid === who.uid || permits(stat, who, W);
}

/**
 * Kann `who` Einträge eines Verzeichnisses auf dem Weg austauschen? Wie `canModify`, aber ein Sticky-Verzeichnis
 * (z. B. /tmp, 1777) erlaubt das nur für eigene Einträge – fremde (root) bleiben unantastbar.
 */
export function canReplaceEntries(stat: Owned, who: ProcessIdentity): boolean {
  return who.uid === 0 || stat.uid === who.uid || (permits(stat, who, W) && (stat.mode & 0o1000) === 0);
}

let names: { users: Map<number, string>; groups: Map<number, string> } | null = null;

function nameMaps(): { users: Map<number, string>; groups: Map<number, string> } {
  if (names !== null) return names;
  const read = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  const users = new Map<number, string>();
  for (const entry of parsePasswd(read("/etc/passwd"))) {
    if (entry.uid !== null && !users.has(entry.uid)) users.set(entry.uid, entry.name);
  }
  const groups = new Map<number, string>();
  for (const entry of parseGroup(read("/etc/group"))) {
    if (entry.gid !== null && !groups.has(entry.gid)) groups.set(entry.gid, entry.name);
  }
  names = { users, groups };
  return names;
}

/** „0750 root:quizmaster“ (Namen laut /etc/passwd und /etc/group, sonst Zahlen). */
export function describeStat(stat: Owned): string {
  const { users, groups } = nameMaps();
  return `${octal(stat.mode)} ${users.get(stat.uid) ?? stat.uid}:${groups.get(stat.gid) ?? stat.gid}`;
}

/** „nicht lesbar und nicht ausführbar“ – fehlende Rechte in Worten (Verzeichnisse: „durchsuchbar“). */
function missingText(stat: Owned & { isDirectory(): boolean }, who: ProcessIdentity, want: number): string {
  const missing = want & ~bitsFor(stat, who);
  const words: string[] = [];
  if (missing & R) words.push("lesbar");
  if (missing & W) words.push("beschreibbar");
  if (missing & X) words.push(stat.isDirectory() ? "durchsuchbar" : "ausführbar");
  return `nicht ${words.join(" und nicht ")}`;
}

/**
 * Verzeichnisse, die der Kernel beim Auflösen von `path` durchsucht: jedes (aufgelöste) Präfix samt seiner
 * Vorfahren – so sind auch Symlink-Ziele wie `current → releases/<sha>` abgedeckt. Kürzeste zuerst.
 */
export function traversedDirectories(path: string): string[] {
  const parts = resolve(path)
    .split(sep)
    .filter((part) => part !== "");
  const dirs = new Set<string>();
  const addWithAncestors = (dir: string) => {
    let current = dir;
    for (;;) {
      dirs.add(current);
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  };
  addWithAncestors(sep);
  let prefix: string = sep;
  for (const part of parts.slice(0, -1)) {
    prefix = join(prefix, part);
    addWithAncestors(realpathSync(prefix));
  }
  return [...dirs].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

export interface PathCheck {
  label: string;
  path: string;
  /** Gewünschte Rechte am Ziel (R, X, R|X …). */
  want: number;
  /** Ziel und durchsuchte Verzeichnisse dürfen für `who` nicht veränderbar sein (alles, was root vorgibt). */
  forbidModify?: boolean;
  /** Pfade nicht nennen (Werte aus Env-Dateien, z. B. tlsCAFile aus MONGODB_URI) – nur `label`. */
  hidePaths?: boolean;
  /** false: `who` muss den Pfad nicht erreichen (nur Unveränderbarkeit prüfen); Standard true. */
  searchable?: boolean;
}

/** Probleme, die `who` mit einem Pfad hätte (leer = in Ordnung). */
export function pathProblems(check: PathCheck, who: ProcessIdentity, userLabel: string): string[] {
  const problems: string[] = [];
  let dirs: string[];
  let target: Stats;
  try {
    dirs = traversedDirectories(check.path);
    target = statSync(check.path);
  } catch {
    return [`${check.label} fehlt oder ist nicht auflösbar`];
  }
  const where = (dir: string, stat: Stats) =>
    check.hidePaths ? `ein Verzeichnis auf dem Weg zu ${check.label}` : `${dir} (${describeStat(stat)})`;
  for (const dir of dirs) {
    const stat = statSync(dir);
    if (check.searchable !== false && !permits(stat, who, X)) {
      problems.push(`${where(dir, stat)} ist für ${userLabel} nicht durchsuchbar`);
    } else if (check.forbidModify && canReplaceEntries(stat, who)) {
      problems.push(`${where(dir, stat)} ist für ${userLabel} veränderbar`);
    }
  }
  if (!permits(target, who, check.want)) {
    problems.push(
      `${check.label} (${describeStat(target)}) ist für ${userLabel} ${missingText(target, who, check.want)}`,
    );
  } else if (check.forbidModify && canModify(target, who)) {
    problems.push(`${check.label} (${describeStat(target)}) ist für ${userLabel} veränderbar`);
  }
  return problems;
}

/** URI-Parameter, die der MongoDB-Treiber als Datei liest (Kleinschreibung → Anzeigename). */
const MONGO_FILE_PARAMS = new Map([
  ["tlscafile", "tlsCAFile"],
  ["tlscertificatekeyfile", "tlsCertificateKeyFile"],
  ["tlscrlfile", "tlsCRLFile"],
]);

/**
 * Dateien, auf die MONGODB_URI verweist (tlsCAFile …) – die Apps lesen sie mit ihren eigenen Rechten. Nur
 * absolute Pfade; Labels nennen den Parameter, nie den Wert.
 */
export function mongoUriFiles(uri: string): { label: string; path: string }[] {
  const query = /\?([^#]*)/.exec(uri)?.[1] ?? "";
  const files: { label: string; path: string }[] = [];
  for (const pair of query.split(/[&;]/)) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const decode = (text: string) => {
      try {
        return decodeURIComponent(text);
      } catch {
        return text;
      }
    };
    const name = MONGO_FILE_PARAMS.get(decode(pair.slice(0, separator)).toLowerCase());
    const path = decode(pair.slice(separator + 1));
    if (name !== undefined && path.startsWith("/")) files.push({ label: `${name} aus MONGODB_URI`, path });
  }
  return files;
}

export interface TreeResult {
  problems: string[];
  entries: number;
}

/**
 * Prüft einen Baum (ohne Symlinks zu folgen): Verzeichnisse lesbar und durchsuchbar, Dateien lesbar (ausführbare
 * auch ausführbar), nichts davon für `who` veränderbar. `exclude`: Pfade, die samt Inhalt übersprungen werden.
 */
export function treeProblems(
  root: string,
  who: ProcessIdentity,
  userLabel: string,
  options: { exclude?: readonly string[]; limit?: number } = {},
): TreeResult {
  const exclude = new Set(options.exclude ?? []);
  const limit = options.limit ?? 10;
  const problems: string[] = [];
  let entries = 0;
  const note = (path: string, stat: Stats, issue: string) => {
    if (problems.length < limit) problems.push(`${relative(dirname(root), path)} (${describeStat(stat)}) ${issue}`);
    else if (problems.length === limit) problems.push("…");
  };
  const pending = [root];
  // Nach `limit` Befunden abbrechen: das Ergebnis steht fest, und ein falsch beschreibbarer Teilbaum wird nicht
  // weiter durchlaufen.
  while (pending.length > 0 && problems.length <= limit) {
    const path = pending.pop() ?? root;
    if (exclude.has(path)) continue;
    const stat = lstatSync(path);
    entries += 1;
    if (stat.isSymbolicLink()) continue;
    // Verzeichnisse brauchen r+x, ausführbare Dateien (x beim Besitzer) r+x, alle anderen r.
    const want = stat.isDirectory() || (stat.mode & 0o100) !== 0 ? R | X : R;
    if (!stat.isDirectory() && !stat.isFile()) note(path, stat, "ist weder Datei noch Verzeichnis");
    else if (!permits(stat, who, want)) note(path, stat, `ist für ${userLabel} ${missingText(stat, who, want)}`);
    else if (canModify(stat, who)) note(path, stat, `ist für ${userLabel} veränderbar`);
    if (stat.isDirectory()) for (const name of readdirSync(path)) pending.push(join(path, name));
  }
  return { problems, entries };
}

// ── Änderungen ──────────────────────────────────────────────────────────────────────────────────

/** Entfernt einen Baum mit GNU `rm -rf --one-file-system` (fts mit O_NOFOLLOW, sicher gegen Symlink-Tausch). */
export type TreeRemover = (path: string) => Promise<void>;

export const removeTree: TreeRemover = async (path) => {
  const result = await run("rm", ["-rf", "--one-file-system", "--", path], {
    env: { PATH: SYSTEM_PATH, LANG: "C" },
    output: "capture",
    timeoutMs: 15 * 60_000,
  });
  if (result.timedOut || result.code !== 0) {
    const detail = result.stderr.trim().split("\n").slice(-2).join(" | ");
    throw new DeployError("REMOVE_FAILED", `rm -rf ${path} fehlgeschlagen${detail ? ` (${detail})` : ""}`);
  }
};

/** Datei oder Verzeichnis des Deploys: muss dem Deploy-Benutzer gehören und darf kein Symlink sein. */
function ownedStat(path: string, kind: "directory" | "file"): Stats {
  const stat = lstatSync(path);
  const fits = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (!fits)
    throw new DeployError("ACCESS_LAYOUT", `${path} ist ${kind === "directory" ? "kein Verzeichnis" : "keine Datei"}`);
  const owner = deployIdentity();
  if (stat.uid !== owner.uid) {
    throw new DeployError("ACCESS_LAYOUT", `${path} gehört uid ${stat.uid}, erwartet ${owner.uid} (Deploy-Benutzer)`);
  }
  return stat;
}

/** Setzt Gruppe und Rechte (Besitzer bleibt der Deploy-Benutzer); nur wenn nötig. */
export function applyAccess(path: string, gid: number, mode: number, kind: "directory" | "file"): void {
  const stat = ownedStat(path, kind);
  if (stat.gid !== gid) chownSync(path, stat.uid, gid);
  if ((stat.mode & 0o7777) !== mode) chmodSync(path, mode);
}

/** `.deploy` bis zum Layout-Verzeichnis (Testmodus: `.deploy` und `.deploy/test`). */
export function deployChain(layout: Layout): string[] {
  const base = join(layout.root, ".deploy");
  const rel = relative(base, layout.deployDir);
  if (rel.startsWith("..")) throw new DeployError("ACCESS_LAYOUT", `${layout.deployDir} liegt nicht unter ${base}`);
  const chain = [base];
  let current = base;
  for (const part of rel.split(sep).filter((piece) => piece !== "")) {
    current = join(current, part);
    chain.push(current);
  }
  return chain;
}

export function webCacheDir(layout: Layout, sha: string): string {
  return join(releaseDir(layout, sha), "web", "apps", "web", ".next", "cache");
}

export type CacheOutcome = "created" | "kept" | "replaced";

/**
 * `.next/cache` eines Releases gehört `owner` (0700). Alles andere an dieser Stelle (anderer Besitzer, Symlink,
 * Datei) wird beiseitegelegt und mit `remove` gelöscht – es ist nur ein Cache. `.next` selbst gehört root, der
 * Dienstbenutzer kann den Eintrag `cache` also nicht austauschen.
 */
export async function ensureWebCache(
  layout: Layout,
  sha: string,
  owner: ProcessIdentity,
  remove: TreeRemover = removeTree,
): Promise<CacheOutcome> {
  const cache = webCacheDir(layout, sha);
  const nextDir = dirname(cache);
  ownedStat(nextDir, "directory");
  let current: Stats | null = null;
  try {
    current = lstatSync(cache);
  } catch {
    current = null;
  }
  if (current?.isDirectory() && current.uid === owner.uid && current.gid === owner.gid) {
    if ((current.mode & 0o7777) !== CACHE_DIR_MODE) chmodSync(cache, CACHE_DIR_MODE);
    return "kept";
  }
  let stale: string | null = null;
  if (current !== null) {
    stale = join(nextDir, `.cache-stale-${process.pid}-${Date.now()}`);
    renameSync(cache, stale);
  }
  mkdirSync(cache, { mode: CACHE_DIR_MODE });
  lchownSync(cache, owner.uid, owner.gid);
  chmodSync(cache, CACHE_DIR_MODE);
  if (stale !== null) await remove(stale);
  return stale === null ? "created" : "replaced";
}

export interface AccessPlan {
  layout: Layout;
  identity: ServiceIdentity;
  /** Releases, die bei dieser Aktion laufen können (Ziel und Rückweg). */
  releases: readonly string[];
  /** Weitere Dateien, die die Apps lesen (z. B. tlsCAFile aus MONGODB_URI) – geprüft wird nur Lesbarkeit. */
  externalFiles?: readonly { label: string; path: string }[];
  /** Ladeskript von pm2 im App-Prozess (lib/ProcessContainerFork.js), falls ermittelbar. */
  pm2Container?: string | null;
  /** Code, den der pm2-CLI als root lädt (ecosystem.config.js, service-user.cjs): darf nie veränderbar sein. */
  rootCode?: readonly { label: string; path: string }[];
  remove?: TreeRemover;
}

/**
 * Stellt Besitz und Rechte her (siehe Kopf) und prüft danach mit Dienstbenutzer, dass er alles Nötige lesen bzw.
 * ausführen und – außer `.next/cache` – nichts verändern kann. Wirft vor der Aktivierung; liefert Statuszeilen.
 */
export async function prepareAccess(plan: AccessPlan): Promise<string[]> {
  const { layout, identity } = plan;
  const service = identity.kind === "service";
  const env = envAccess(identity);
  const lines: string[] = [];

  if (service) {
    // Nur durchsuchbar (x): der Dienstbenutzer erreicht current, runtime und env, kann aber nichts auflisten.
    for (const dir of deployChain(layout)) applyAccess(dir, lstatSync(dir).gid, DEPLOY_DIR_MODE, "directory");
  }
  mkdirSync(layout.releasesDir, { recursive: true, mode: 0o700 });
  applyAccess(layout.releasesDir, env.gid, service ? RELEASES_MODES.service : RELEASES_MODES.root, "directory");
  mkdirSync(layout.envDir, { recursive: true, mode: env.dirMode });
  applyAccess(layout.envDir, env.gid, env.dirMode, "directory");
  const envFiles = APP_KEYS.map((app) => envFile(layout, app)).filter((file) => existsSync(file));
  for (const file of envFiles) applyAccess(file, env.gid, env.fileMode, "file");

  const owner = appIdentity(identity);
  const releases = [...new Set(plan.releases)];
  const outcomes: string[] = [];
  for (const sha of releases) {
    const outcome = await ensureWebCache(layout, sha, owner, plan.remove ?? removeTree);
    outcomes.push(`${short(sha)} ${outcome === "kept" ? "vorhanden" : outcome === "created" ? "angelegt" : "ersetzt"}`);
  }
  const envLine = `${describeStat(lstatSync(layout.envDir))}, Env-Dateien ${octal(env.fileMode)}`;
  const releasesLine = `.deploy/releases ${describeStat(lstatSync(layout.releasesDir))}`;
  if (!service) {
    lines.push(`kein Dienstbenutzer: .deploy/env ${envLine}, ${releasesLine} (nur root)`);
    lines.push(`.next/cache gehört root (${outcomes.join(", ")})`);
    return lines;
  }

  const who = owner;
  const label = identity.user;
  const check = (item: PathCheck) => pathProblems(item, who, label);
  const problems: string[] = [
    ...check({ label: "Deploy-Verzeichnis", path: layout.deployDir, want: X, forbidModify: true }),
    ...check({ label: ".deploy/releases", path: layout.releasesDir, want: R | X, forbidModify: true }),
    ...check({
      label: "Node-Laufzeit",
      path: join(layout.runtimeDir, "node", "bin", "node"),
      want: R | X,
      forbidModify: true,
    }),
    ...check({ label: ".deploy/env", path: layout.envDir, want: X, forbidModify: true }),
    ...envFiles.flatMap((file) =>
      check({ label: relative(layout.deployDir, file), path: file, want: R, forbidModify: true }),
    ),
  ];
  let entries = 0;
  for (const sha of releases) {
    const cache = webCacheDir(layout, sha);
    const tree = treeProblems(releaseDir(layout, sha), who, label, { exclude: [cache] });
    entries += tree.entries;
    problems.push(...tree.problems, ...check({ label: `.next/cache (${short(sha)})`, path: cache, want: R | W | X }));
  }
  for (const file of plan.externalFiles ?? []) {
    problems.push(...check({ label: file.label, path: file.path, want: R, hidePaths: true }));
  }
  if (plan.pm2Container)
    problems.push(...check({ label: "pm2 ProcessContainerFork.js", path: plan.pm2Container, want: R }));
  // Was der pm2-CLI als root ausführt (ecosystem.config.js, service-user.cjs), darf der Dienstbenutzer nie ändern.
  for (const file of plan.rootCode ?? []) {
    problems.push(...check({ label: file.label, path: file.path, want: 0, forbidModify: true, searchable: false }));
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, 8).join("; ") + (problems.length > 8 ? ` … (+${problems.length - 8})` : "");
    throw new DeployError("SERVICE_ACCESS", `Rechte passen nicht für ${describeIdentity(identity)}: ${shown}`);
  }
  lines.push(`.deploy ${octal(DEPLOY_DIR_MODE)} root, ${releasesLine}, .deploy/env ${envLine}`);
  lines.push(
    `Release ${releases.map(short).join(", ")} für ${label} lesbar, nicht veränderbar (${entries} Einträge geprüft); ` +
      `.next/cache gehört ${label} (${outcomes.join(", ")})`,
  );
  return lines;
}

// ── Prozess-Identität (Smoke-Test, Status) ──────────────────────────────────────────────────────

export interface ProcStatus {
  /** real, effektiv, gespeichert, Dateisystem */
  uids: number[];
  gids: number[];
  /** Zusatzgruppen */
  groups: number[];
}

/** Wertet /proc/<pid>/status aus (Zeilen Uid, Gid, Groups). */
export function parseProcStatus(text: string): ProcStatus {
  const field = (name: string): number[] | null => {
    const line = text.split("\n").find((candidate) => candidate.startsWith(`${name}:`));
    if (line === undefined) return null;
    return line
      .slice(name.length + 1)
      .trim()
      .split(/\s+/)
      .filter((part) => part !== "")
      .map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  };
  const uids = field("Uid");
  const gids = field("Gid");
  const groups = field("Groups") ?? [];
  if (uids?.length !== 4 || gids?.length !== 4 || [...uids, ...gids, ...groups].some(Number.isNaN)) {
    throw new DeployError("PROC_STATUS", "Prozessstatus (Uid/Gid) nicht auswertbar");
  }
  return { uids, gids, groups };
}

export function readProcStatus(pid: number): ProcStatus {
  return parseProcStatus(readFileSync(`/proc/${pid}/status`, "utf8"));
}

/** Abweichung von der erwarteten Identität (null = passt); `strictGroups`: keine fremden Zusatzgruppen. */
export function identityMismatch(status: ProcStatus, expected: ProcessIdentity, strictGroups: boolean): string | null {
  if (status.uids.some((uid) => uid !== expected.uid)) return `uid ${status.uids.join("/")} statt ${expected.uid}`;
  if (status.gids.some((gid) => gid !== expected.gid)) return `gid ${status.gids.join("/")} statt ${expected.gid}`;
  if (strictGroups && status.groups.some((gid) => gid !== expected.gid)) {
    return `Zusatzgruppen ${status.groups.join(",")} (erwartet keine)`;
  }
  return null;
}

/** Name zur uid (für Statusausgaben). */
export function userLabel(uid: number): string {
  return nameMaps().users.get(uid) ?? `uid ${uid}`;
}
