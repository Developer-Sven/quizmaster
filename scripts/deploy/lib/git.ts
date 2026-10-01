/**
 * Git-Zugriffe des Deploys: Revision auflösen, Arbeitsbaum prüfen, Quelltext per `git archive` holen.
 * Gebaut wird immer ein committeter Stand – nie der Arbeitsbaum (ADR-025).
 */
import { mkdirSync } from "node:fs";
import { SHA_PATTERN } from "./layout.ts";
import { DeployError } from "./log.ts";
import { pipe, run, SYSTEM_PATH } from "./proc.ts";

const gitEnv = (): Record<string, string> => ({
  PATH: SYSTEM_PATH,
  HOME: process.env.HOME ?? "/root",
  LANG: "C",
  GIT_TERMINAL_PROMPT: "0",
});

async function git(repo: string, args: string[]): Promise<string> {
  const result = await run("git", ["-C", repo, ...args], { env: gitEnv(), output: "capture", timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new DeployError("GIT_FAILED", `git ${args[0]}: ${result.stderr.trim().split("\n").at(-1) ?? "Fehler"}`);
  }
  return result.stdout;
}

/** Revision (Branch, Tag, kurzer oder voller SHA) → voller Commit-SHA. */
export async function resolveCommit(repo: string, rev: string): Promise<string> {
  if (rev.startsWith("-")) throw new DeployError("GIT_REV", "ungültige Revision");
  const sha = (await git(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).catch(() => "")).trim();
  if (!SHA_PATTERN.test(sha)) throw new DeployError("GIT_REV", `Revision ${rev} nicht gefunden`);
  return sha;
}

export async function commitSubject(repo: string, sha: string): Promise<string> {
  return (await git(repo, ["log", "-1", "--format=%s", sha]).catch(() => "")).trim();
}

/** Pfade mit Änderungen oder unversionierten Dateien (ohne .gitignore-Treffer). */
export function parsePorcelainZ(output: string): string[] {
  const entries = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // Umbenennungen/Kopien: der Ursprungspfad folgt als eigener Eintrag.
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return paths;
}

export async function dirtyPaths(repo: string): Promise<string[]> {
  return parsePorcelainZ(await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]));
}

/**
 * Pfade, die der Betrieb selbst pflegt und die einen Deploy nicht blockieren: die Cloudflare-IP-Liste
 * aktualisiert der wöchentliche Cron (`install-site.sh --refresh-ips`) – sie gehört committet, beeinflusst
 * den Build aber nicht.
 */
export const OPERATIONAL_PATHS: readonly string[] = ["infra/caddy/cloudflare-ips.txt"];

/**
 * Geänderte Dateien zwischen zwei Commits, beschränkt auf `paths` (Verzeichnisse oder Dateien). `null`, wenn der
 * Vergleich nicht möglich ist (z. B. Commit eines alten Releases nicht mehr im Repository).
 */
export async function changedPaths(
  repo: string,
  from: string,
  to: string,
  paths: readonly string[],
): Promise<string[] | null> {
  if (!SHA_PATTERN.test(from) || !SHA_PATTERN.test(to)) return null;
  const result = await run("git", ["-C", repo, "diff", "--name-only", "--no-renames", from, to, "--", ...paths], {
    env: gitEnv(),
    output: "capture",
    timeoutMs: 60_000,
  });
  if (result.code !== 0 || result.timedOut) return null;
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Quelltext eines Commits nach `dest` entpacken. */
export async function extractArchive(repo: string, sha: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true, mode: 0o755 });
  await pipe(
    { bin: "git", args: ["-C", repo, "archive", "--format=tar", sha] },
    { bin: "tar", args: ["-x", "-C", dest, "--no-same-owner", "--no-same-permissions"] },
    gitEnv(),
    300_000,
  );
}
