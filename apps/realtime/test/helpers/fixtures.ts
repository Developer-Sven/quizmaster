/**
 * Synthetischer Fragenkatalog aus `test/fixtures/content` (ADR-021) als Seed-Eingabe für `seedCatalog()`.
 * Wird je Prozess einmal gelesen und validiert (Schema der Content-Dateien).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SeedInput, SeedQuestionInput } from "@quizmaster/db";
import { categoriesFileSchema, questionFileSchema } from "@quizmaster/shared/content";

/** Repo-Pfad der Fixtures (apps/realtime/test/helpers → ../../../../test/fixtures/content). */
export const FIXTURES_CONTENT_DIR = resolve(import.meta.dirname, "../../../../test/fixtures/content");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const cache = new Map<string, SeedInput>();

/** Lädt `categories.json` und alle `questions/<kategorie>/<thema>.json` eines Content-Ordners. */
export function loadFixtureCatalog(contentDir: string = FIXTURES_CONTENT_DIR): SeedInput {
  const cached = cache.get(contentDir);
  if (cached !== undefined) return cached;
  const categoriesFile = categoriesFileSchema.parse(readJson(join(contentDir, "categories.json")));
  const questions: SeedQuestionInput[] = [];
  const questionsDir = join(contentDir, "questions");
  for (const category of readdirSync(questionsDir).sort()) {
    const categoryDir = join(questionsDir, category);
    for (const fileName of readdirSync(categoryDir).sort()) {
      if (!fileName.endsWith(".json")) continue;
      const file = questionFileSchema.parse(readJson(join(categoryDir, fileName)));
      for (const entry of file.questions) questions.push({ category: file.category, topic: file.topic, entry });
    }
  }
  const catalog: SeedInput = { categoriesFile, questions };
  cache.set(contentDir, catalog);
  return catalog;
}
