/**
 * Pfade der Content-Pipeline. Die Repo-Wurzel kommt aus `import.meta.dirname` (nicht aus dem cwd), damit
 * die Skripte aus jedem Verzeichnis und über `pnpm --filter` gleich funktionieren.
 */
import { isAbsolute, relative, resolve } from "node:path";

/** scripts/content/lib → ../../.. */
export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
/** Privater Katalog (ADR-021: lokal, nicht im öffentlichen Repo). */
export const DEFAULT_CONTENT_DIR = resolve(REPO_ROOT, "content");
/** Synthetische Fixtures für CI/E2E (öffentlich). */
export const FIXTURES_CONTENT_DIR = resolve(REPO_ROOT, "test/fixtures/content");
export const CATEGORIES_FILE = "categories.json";
export const QUESTIONS_DIR = "questions";
export const STATUS_FILE = "STATUS.md";

/**
 * Löst einen CLI-Pfad relativ zum Aufruf-Verzeichnis auf. pnpm startet das Skript im Paketordner
 * `scripts/` und setzt `INIT_CWD` – bei den Root-Skripten (`pnpm content:*`) ist das die Repo-Wurzel,
 * relative Pfade gelten dann also ab der Wurzel (z. B. `--file content/questions/…`). Direkt mit
 * `node scripts/content/….ts` gilt das aktuelle Verzeichnis.
 */
export function resolveCliPath(path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

/** Pfad für Ausgaben: relativ zur Repo-Wurzel, sonst absolut. */
export function displayPath(path: string): string {
  const rel = relative(REPO_ROOT, path);
  return rel === "" ? "." : rel.startsWith("..") ? path : rel;
}

/** true, wenn `path` innerhalb von `dir` liegt (oder gleich ist). */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
