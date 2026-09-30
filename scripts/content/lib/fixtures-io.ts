/**
 * Schreiben und Prüfen der Fixture-Dateien. Formatiert wird mit Biome (wie der Rest des Repos), die
 * Prüfung (`--check`) vergleicht den JSON-Inhalt – die Formatierung prüft `biome check`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildFixtures } from "./fixtures.ts";
import { listQuestionFiles } from "./load.ts";
import { CATEGORIES_FILE, REPO_ROOT } from "./paths.ts";

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

/** Schreibt alle Fixtures, entfernt überzählige Themen-Dateien und formatiert mit Biome. */
export function writeFixtures(dir: string): { written: number; removed: number; formatted: boolean } {
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
