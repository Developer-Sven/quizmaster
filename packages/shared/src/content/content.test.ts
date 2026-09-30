import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_ID_PREFIXES,
  CATEGORY_SLUGS,
  categoriesFileSchema,
  DEFAULT_DIFFICULTY_MIX,
  isPlayableStatus,
  QUESTION_ID_REGEX,
  questionFileSchema,
  questionIdMatchesCategory,
  toDbQuestionStatus,
} from "./index.ts";
import { buildQuestionFileJsonSchema, serializeJsonSchema } from "./json-schema.ts";

const packageRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(packageRoot, "../..");
/** Lokaler Katalog (ADR-021: nicht im öffentlichen Repo, in CI fehlt er → Tests werden übersprungen). */
const contentDir = join(repoRoot, "content");

/** Beispiel aus docs/08 §3. */
const exampleFile = {
  category: "rund-um-die-welt",
  topic: "hauptstaedte",
  questions: [
    {
      id: "rw-8f3k2m1q",
      difficulty: 1,
      prompt: "Was ist die Hauptstadt von Frankreich?",
      answers: ["Paris", "Lyon", "Marseille", "Nizza"],
      status: "unverified",
    },
    {
      id: "rw-2hq9d7sa",
      difficulty: 2,
      prompt: "Zu welchem Land gehört diese Flagge?",
      media: { kind: "flag", code: "jp" },
      answers: ["Japan", "Bangladesch", "Palau", "Südkorea"],
      status: "unverified",
    },
    {
      id: "zz-k2m9x7qa",
      difficulty: 2,
      prompt: "In welchem Jahr fiel die Berliner Mauer?",
      answers: ["1989", "1987", "1990", "1991"],
      displayOrder: "asc",
      status: "unverified",
    },
  ],
};

type Question = (typeof exampleFile.questions)[number] & Record<string, unknown>;

function withQuestion(patch: Record<string, unknown>, remove: string[] = []) {
  const [first] = exampleFile.questions;
  const question: Question = { ...first, ...patch } as Question;
  for (const key of remove) delete question[key];
  return { ...exampleFile, questions: [question] };
}

const review = { checkedAt: "2026-09-30", checkedBy: "fakten-pruefer", notes: null };

describe("Fragen-Datei (docs/08 §3)", () => {
  it("akzeptiert das Beispiel aus docs/08 (answers[0] = richtig)", () => {
    const parsed = questionFileSchema.parse(exampleFile);
    expect(parsed.questions[0]?.answers[0]).toBe("Paris");
  });

  it("akzeptiert belegte Fragen mit Quelle, Review und Stand-Datum", () => {
    const approved = withQuestion({
      status: "approved",
      source: "https://de.wikipedia.org/wiki/Paris",
      review,
      volatile: true,
      asOf: "2026-09-01",
      explanation: "Paris ist seit dem Mittelalter Hauptstadt.",
    });
    expect(questionFileSchema.safeParse(approved).success).toBe(true);
    expect(questionFileSchema.safeParse(withQuestion({ status: "needs_fix", review })).success).toBe(true);
  });

  it.each([
    ["ungültige ID", { id: "rw-123" }],
    ["unbekanntes Kürzel", { id: "xx-8f3k2m1q" }],
    ["Frage ohne Fragezeichen", { prompt: "Was ist die Hauptstadt von Frankreich" }],
    ["Frage zu kurz", { prompt: "Paris?" }],
    ["Frage zu lang", { prompt: `${"x".repeat(140)}?` }],
    ["nur 3 Antworten", { answers: ["a", "b", "c"] }],
    ["5 Antworten", { answers: ["a", "b", "c", "d", "e"] }],
    ["doppelte Antworten", { answers: ["Paris", "Lyon", "Paris", "Nizza"] }],
    ["Antwort zu lang", { answers: ["x".repeat(41), "b", "c", "d"] }],
    ["leere Antwort", { answers: ["", "b", "c", "d"] }],
    ["Schwierigkeit 6", { difficulty: 6 }],
    ["Schwierigkeit 2.5", { difficulty: 2.5 }],
    ["unbekannter Status", { status: "draft" }],
    ["unbekanntes Feld", { hint: "x" }],
    ["approved ohne Beleg", { status: "approved" }],
    ["approved ohne Review", { status: "approved", source: "https://example.org" }],
    ["needs_fix ohne Review", { status: "needs_fix" }],
    ["volatile ohne asOf", { volatile: true }],
    ["ungültiges Datum", { volatile: true, asOf: "2026-02-30" }],
    ["http-Quelle", { status: "approved", source: "http://example.org", review }],
    ["Erklärung zu lang", { explanation: "x".repeat(201) }],
    ["falscher Flaggen-Code", { media: { kind: "flag", code: "JP" } }],
    ["anderes Medium", { media: { kind: "image", code: "jp" } }],
    ["displayOrder desc", { displayOrder: "desc" }],
  ])("lehnt ab: %s", (_label, patch) => {
    expect(questionFileSchema.safeParse(withQuestion(patch)).success).toBe(false);
  });

  it("lehnt fehlende Pflichtfelder, leere Listen und unbekannte Kategorien ab", () => {
    for (const key of ["id", "difficulty", "prompt", "answers", "status"]) {
      expect(questionFileSchema.safeParse(withQuestion({}, [key])).success, key).toBe(false);
    }
    expect(questionFileSchema.safeParse({ ...exampleFile, questions: [] }).success).toBe(false);
    expect(questionFileSchema.safeParse({ ...exampleFile, category: "politik" }).success).toBe(false);
    expect(questionFileSchema.safeParse({ ...exampleFile, topic: "Haupt Städte" }).success).toBe(false);
    expect(questionFileSchema.safeParse({ ...exampleFile, extra: 1 }).success).toBe(false);
  });

  it("prüft das ID-Kürzel je Kategorie und bildet den DB-Status ab", () => {
    expect(questionIdMatchesCategory("rw-8f3k2m1q", "rund-um-die-welt")).toBe(true);
    expect(questionIdMatchesCategory("zz-k2m9x7qa", "rund-um-die-welt")).toBe(false);
    expect(Object.keys(CATEGORY_ID_PREFIXES)).toEqual([...CATEGORY_SLUGS]);
    expect(new Set(Object.values(CATEGORY_ID_PREFIXES)).size).toBe(19);
    expect(toDbQuestionStatus("needs_fix")).toBe("retired");
    expect(toDbQuestionStatus("approved")).toBe("approved");
    expect(isPlayableStatus("unverified", "all")).toBe(true);
    expect(isPlayableStatus("unverified", "approved")).toBe(false);
    expect(isPlayableStatus("retired", "all")).toBe(false);
  });
});

describe("categories.json", () => {
  const syntheticCategories = {
    version: 1,
    updated: "2026-09-30",
    note: "Testdaten",
    targets: { start: 10, ausbau: 20, minPlayable: 5 },
    difficultyMix: { ...DEFAULT_DIFFICULTY_MIX },
    methods: { ki: "a", wikidata: "b", prozedural: "c", mix: "d" },
    categories: [
      {
        slug: "im-labor",
        name: "Im Labor",
        icon: "flask-conical",
        color: "#26D9B5",
        order: 1,
        active: true,
        description: "Naturwissenschaften",
        scope: "Chemie, Physik",
        notScope: "Technik (→ Wunder der Technik)",
        targets: { start: 10, ausbau: 20 },
        rules: [],
        topics: [{ id: "chemie", name: "Chemie", target: 10, method: "ki" }],
      },
    ],
  };

  it("akzeptiert eine synthetische Datei (CI-Fixtures) und prüft Eindeutigkeit und Mix", () => {
    expect(categoriesFileSchema.safeParse(syntheticCategories).success).toBe(true);
    const [category] = syntheticCategories.categories;
    if (!category) throw new Error("Testdaten unvollständig");
    const broken: unknown[] = [
      { ...syntheticCategories, categories: [category, category] },
      { ...syntheticCategories, difficultyMix: { ...DEFAULT_DIFFICULTY_MIX, "1": 0.5 } },
      { ...syntheticCategories, categories: [{ ...category, topics: [...category.topics, ...category.topics] }] },
      { ...syntheticCategories, categories: [{ ...category, color: "blau" }] },
      { ...syntheticCategories, categories: [{ ...category, slug: "politik" }] },
      { ...syntheticCategories, methods: { ki: "a" } },
    ];
    for (const entry of broken) expect(categoriesFileSchema.safeParse(entry).success).toBe(false);
  });

  it.skipIf(!existsSync(join(contentDir, "categories.json")))("validiert den lokalen Katalog", () => {
    const file = categoriesFileSchema.parse(JSON.parse(readFileSync(join(contentDir, "categories.json"), "utf8")));
    expect(file.categories.map((category) => category.slug)).toEqual([...CATEGORY_SLUGS]);
    expect(file.targets.minPlayable).toBe(100);
    expect(file.difficultyMix).toEqual(DEFAULT_DIFFICULTY_MIX);
  });
});

describe("JSON-Schema (gen:schema)", () => {
  const generatedPath = join(packageRoot, "schema", "question-file.schema.json");

  it("die erzeugte Datei ist aktuell (sonst: pnpm --filter @quizmaster/shared gen:schema)", () => {
    const onDisk: unknown = JSON.parse(readFileSync(generatedPath, "utf8"));
    expect(onDisk).toEqual(buildQuestionFileJsonSchema());
    expect(serializeJsonSchema({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it("enthält die bedingten Regeln, eindeutige Antworten und die Metadaten", () => {
    const schema = buildQuestionFileJsonSchema();
    expect(schema.$id).toBe("https://quizmaster.example/schema/question-file.schema.json");
    expect(JSON.stringify(schema)).toContain('"uniqueItems":true');
    expect(JSON.stringify(schema)).toContain('"then":{"required":["source","review"]}');
    expect(JSON.stringify(schema)).toContain(QUESTION_ID_REGEX.source);
  });

  it.skipIf(!existsSync(join(contentDir, "schema", "question-file.schema.json")))(
    "entspricht content/schema/question-file.schema.json",
    () => {
      const original: unknown = JSON.parse(
        readFileSync(join(contentDir, "schema", "question-file.schema.json"), "utf8"),
      );
      expect(isDeepStrictEqual(buildQuestionFileJsonSchema(), original)).toBe(true);
    },
  );
});

describe.skipIf(!existsSync(join(contentDir, "questions")))("Lokaler Fragenkatalog", () => {
  it("alle Fragen-Dateien entsprechen dem Schema und die IDs passen zur Kategorie", () => {
    const questionsDir = join(contentDir, "questions");
    let count = 0;
    const ids = new Set<string>();
    for (const category of readdirSync(questionsDir)) {
      for (const fileName of readdirSync(join(questionsDir, category))) {
        const result = questionFileSchema.safeParse(
          JSON.parse(readFileSync(join(questionsDir, category, fileName), "utf8")),
        );
        if (!result.success) throw new Error(`${category}/${fileName}: ${result.error.message}`);
        expect(result.data.category).toBe(category);
        for (const question of result.data.questions) {
          expect(questionIdMatchesCategory(question.id, result.data.category), question.id).toBe(true);
          ids.add(question.id);
          count++;
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(22_472);
    expect(ids.size).toBe(count);
  });
});
