import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDigest } from "./digest.ts";
import {
  buildFixtures,
  FIXTURE_CATEGORIES,
  FIXTURE_MIN_PLAYABLE,
  fixtureQuestionCount,
  isFixtureCatalog,
} from "./fixtures.ts";
import { checkFixtures, fixtureFileMap } from "./fixtures-io.ts";
import { loadCatalog } from "./load.ts";
import { DEFAULT_CONTENT_DIR, FIXTURES_CONTENT_DIR, STATUS_FILE } from "./paths.ts";
import { computeStats, renderGaps, renderStatusMarkdown } from "./stats.ts";

const hasContent = existsSync(join(DEFAULT_CONTENT_DIR, "categories.json"));

describe("Fixtures (test/fixtures/content)", () => {
  it("sind deterministisch und aktuell (Generator == Dateien)", () => {
    expect(JSON.stringify([...fixtureFileMap()])).toBe(JSON.stringify([...fixtureFileMap()]));
    expect(checkFixtures(FIXTURES_CONTENT_DIR)).toEqual([]);
  });

  it("haben 19 Kategorien mit je 10–12 Fragen, Flaggen- und Zahlenfragen, minPlayable 3", () => {
    const { categoriesFile, questionFiles } = buildFixtures();
    expect(categoriesFile.categories).toHaveLength(19);
    expect(categoriesFile.targets.minPlayable).toBe(FIXTURE_MIN_PLAYABLE);
    expect(isFixtureCatalog(categoriesFile)).toBe(true);
    for (const category of FIXTURE_CATEGORIES) {
      const count = questionFiles
        .filter(({ file }) => file.category === category.slug)
        .reduce((sum, { file }) => sum + file.questions.length, 0);
      expect(count).toBe(fixtureQuestionCount(category));
      expect(count).toBeGreaterThanOrEqual(10);
      expect(count).toBeLessThanOrEqual(12);
    }
    const all = questionFiles.flatMap(({ file }) => file.questions);
    expect(all.filter((question) => question.media?.kind === "flag").length).toBeGreaterThanOrEqual(4);
    expect(all.filter((question) => question.displayOrder === "asc")).toHaveLength(38);
    expect(all.every((question) => question.prompt.startsWith("Fixture-"))).toBe(true);
  });

  it.skipIf(!hasContent)(
    "übernehmen Slug, Name, Icon, Farbe und Reihenfolge aus dem echten Katalog – sonst nichts",
    () => {
      const real = loadCatalog(DEFAULT_CONTENT_DIR);
      const fixtures = buildFixtures();
      const pick = (list: ReadonlyArray<{ slug: string; name: string; icon: string; color: string; order: number }>) =>
        list.map(({ slug, name, icon, color, order }) => ({ slug, name, icon, color, order }));
      expect(pick(fixtures.categoriesFile.categories)).toEqual(pick(real.categoriesFile?.categories ?? []));
      const realPrompts = new Set(real.questions.map((question) => question.entry.prompt));
      const fixturePrompts = fixtures.questionFiles.flatMap(({ file }) =>
        file.questions.map((question) => question.prompt),
      );
      expect(fixturePrompts.some((prompt) => realPrompts.has(prompt))).toBe(false);
      const realDescriptions = new Set(real.categoriesFile?.categories.map((category) => category.description));
      expect(fixtures.categoriesFile.categories.some((category) => realDescriptions.has(category.description))).toBe(
        false,
      );
    },
  );
});

describe("content:stats", () => {
  it("zählt spielbare Fragen je Kategorie/Thema/Schwierigkeit und listet alle Status", () => {
    const catalog = loadCatalog(FIXTURES_CONTENT_DIR);
    if (catalog.categoriesFile === null) throw new Error("Fixtures ohne categories.json");
    const stats = computeStats(catalog.categoriesFile, catalog.questions);
    expect(stats.byStatus.needs_fix).toBe(1);
    expect(stats.byStatus.retired).toBe(1);
    expect(stats.total).toBe(catalog.questions.length - 2);
    const markdown = renderStatusMarkdown(stats, new Date("2026-09-30T12:00:00Z"));
    expect(markdown).toContain("> Automatisch erzeugt am 30.09.2026. Status: ");
    expect(markdown).toContain("## Status je Kategorie");
    expect(markdown).toMatch(/\| \*\*Gesamt\*\* \| \*\*207\*\* \|/);
    expect(markdown.endsWith("|\n\n")).toBe(true);
    expect(renderGaps(stats)).toContain("fehlen");
  });

  it.skipIf(!hasContent)("erzeugt STATUS.md für den echten Katalog byte-gleich zum bestehenden Format", () => {
    const current = readFileSync(join(DEFAULT_CONTENT_DIR, STATUS_FILE), "utf8");
    const date = /erzeugt am (\d{2})\.(\d{2})\.(\d{4})/.exec(current);
    expect(date).not.toBeNull();
    const [, day, month, year] = date ?? [];
    const catalog = loadCatalog(DEFAULT_CONTENT_DIR);
    if (catalog.categoriesFile === null) throw new Error("categories.json fehlt");
    const rendered = renderStatusMarkdown(
      computeStats(catalog.categoriesFile, catalog.questions),
      new Date(`${year}-${month}-${day}T12:00:00Z`),
    );
    expect(rendered).toBe(current);
  });
});

describe("content:digest", () => {
  it("listet „Frage → richtige Antwort“ je Thema, nicht spielbare markiert", () => {
    const catalog = loadCatalog(FIXTURES_CONTENT_DIR);
    const categoriesFile = catalog.categoriesFile;
    if (categoriesFile === null) throw new Error("Fixtures ohne categories.json");
    const digest = renderDigest(categoriesFile, catalog.questions, "comics");
    expect(digest).toContain("## Grundlagen (grundlagen)");
    expect(digest).toMatch(/Fixture-Frage 1 zu Comics\? → Richtig 1/);
    expect(digest).toContain("{needs_fix}");
    expect(renderDigest(categoriesFile, catalog.questions, "rund-um-die-welt", "flaggen")).toContain("[Flagge de]");
    expect(() => renderDigest(categoriesFile, catalog.questions, "gibtsnicht")).toThrow(/Unbekannte Kategorie/);
  });
});
