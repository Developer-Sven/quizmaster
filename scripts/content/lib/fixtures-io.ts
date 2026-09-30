/**
 * Schreiben und Prüfen der Fixture-Dateien. Formatiert wird mit Biome (wie der Rest des Repos), die
 * Prüfung (`--check`) vergleicht den JSON-Inhalt – die Formatierung prüft `biome check`.
 *
 * `writeFixtures` löscht überzählige JSON-Dateien im Ziel. Damit ein falsches `--out` nie einen echten
 * Katalog vernichtet, prüft `fixtureTargetProblem` das Ziel vorher (siehe dort).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildFixtures, isFixtureCatalog } from "./fixtures.ts";
import { listQuestionFiles } from "./load.ts";
import {
  CATEGORIES_FILE,
  DEFAULT_CONTENT_DIR,
  displayPath,
  FIXTURES_CONTENT_DIR,
  isInside,
  REPO_ROOT,
} from "./paths.ts";

/** Ziel für Fixtures ist nicht erlaubt – es wurde nichts gelöscht oder geschrieben. */
export class FixtureTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureTargetError";
  }
}

export interface FixtureTargetOptions {
  /** Privater Katalog, in den nie Fixtures geschrieben werden (Standard: content/). */
  privateContentDir?: string;
  /** Fixture-Ordner des Repos (Standard: test/fixtures/content). */
  fixturesDir?: string;
}

/** Absoluter Pfad mit aufgelösten Symlinks – auch für (noch) nicht vorhandene Ordner (nächster Vorfahr). */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

/**
 * Grund, warum `dir` kein zulässiges Fixture-Ziel ist – `null` = zulässig. Erlaubt sind nur der
 * Fixture-Ordner des Repos, ein fehlender oder leerer Ordner und ein Ordner, dessen categories.json als
 * Fixture-Katalog markiert ist (`FIXTURE_NOTE`). Der private Katalog, Ordner darin und Ordner darüber
 * sind immer tabu (auch über Symlinks).
 */
export function fixtureTargetProblem(dir: string, options: FixtureTargetOptions = {}): string | null {
  const target = canonicalPath(dir);
  const privateDir = canonicalPath(options.privateContentDir ?? DEFAULT_CONTENT_DIR);
  if (isInside(target, privateDir) || isInside(privateDir, target)) {
    return `${displayPath(dir)} ist oder enthält den privaten Katalog (${displayPath(privateDir)}) – dorthin nie Fixtures`;
  }
  if (target === canonicalPath(options.fixturesDir ?? FIXTURES_CONTENT_DIR)) return null;
  if (!existsSync(target)) return null;
  if (!statSync(target).isDirectory()) return `${displayPath(dir)} ist kein Ordner`;
  if (readdirSync(target).length === 0) return null;
  const categoriesPath = join(target, CATEGORIES_FILE);
  if (!existsSync(categoriesPath)) {
    return `${displayPath(dir)} ist nicht leer und kein Fixture-Katalog (${CATEGORIES_FILE} fehlt)`;
  }
  let note: unknown;
  try {
    note = (JSON.parse(readFileSync(categoriesPath, "utf8")) as { note?: unknown } | null)?.note;
  } catch {
    return `${displayPath(dir)}: ${CATEGORIES_FILE} ist nicht lesbar – kein Fixture-Katalog`;
  }
  if (typeof note === "string" && isFixtureCatalog({ note })) return null;
  return `${displayPath(dir)} enthält einen echten Katalog (${CATEGORIES_FILE} ohne Fixture-Markierung)`;
}

/** Alle Fixture-Dateien: Pfad relativ zum Content-Ordner → JSON-Wert. */
export function fixtureFileMap(): Map<string, unknown> {
  const fixtures = buildFixtures();
  const ids = new Set<string>();
  for (const { file } of fixtures.questionFiles) {
    for (const question of file.questions) {
      if (ids.has(question.id)) throw new Error(`Fixture-ID doppelt: ${question.id}`);
      ids.add(question.id);
    }
  }
  const files = new Map<string, unknown>([[CATEGORIES_FILE, fixtures.categoriesFile]]);
  for (const { path, file } of fixtures.questionFiles) files.set(path, file);
  return files;
}

function existingJsonFiles(dir: string): string[] {
  const paths = listQuestionFiles(dir).map((path) => relative(dir, path).split(sep).join("/"));
  return existsSync(join(dir, CATEGORIES_FILE)) ? [CATEGORIES_FILE, ...paths] : paths;
}

/** Unterschiede zwischen erzeugten und vorhandenen Fixtures (leer = aktuell). */
export function checkFixtures(dir: string): string[] {
  const expected = fixtureFileMap();
  const problems: string[] = [];
  for (const [path, value] of expected) {
    const absolute = join(dir, path);
    if (!existsSync(absolute)) {
      problems.push(`fehlt: ${path}`);
      continue;
    }
    const actual: unknown = JSON.parse(readFileSync(absolute, "utf8"));
    if (!isDeepStrictEqual(actual, value)) problems.push(`veraltet: ${path}`);
  }
  for (const path of existingJsonFiles(dir)) {
    if (!expected.has(path)) problems.push(`überzählig: ${path}`);
  }
  return problems;
}

/**
 * Schreibt alle Fixtures, entfernt überzählige Themen-Dateien und formatiert mit Biome. Wirft
 * `FixtureTargetError` (ohne etwas anzufassen), wenn `dir` kein zulässiges Ziel ist.
 */
export function writeFixtures(
  dir: string,
  options: FixtureTargetOptions = {},
): { written: number; removed: number; formatted: boolean } {
  const problem = fixtureTargetProblem(dir, options);
  if (problem !== null) throw new FixtureTargetError(`Abbruch, nichts geändert: ${problem}`);
  const expected = fixtureFileMap();
  let removed = 0;
  for (const path of existingJsonFiles(dir)) {
    if (expected.has(path)) continue;
    rmSync(join(dir, path));
    removed += 1;
  }
  for (const [path, value] of expected) {
    const absolute = join(dir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
  }
  const biome = join(REPO_ROOT, "node_modules", ".bin", "biome");
  let formatted = false;
  if (existsSync(biome)) {
    execFileSync(biome, ["format", "--write", dir], { cwd: REPO_ROOT, stdio: "pipe" });
    formatted = true;
  }
  return { written: expected.size, removed, formatted };
}
