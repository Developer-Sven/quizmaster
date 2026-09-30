import {
  type CategoriesFile,
  categoriesFileSchema,
  type QuestionFileEntry,
  questionFileEntrySchema,
} from "@quizmaster/shared/content";
import { APP_CONFIG_ID } from "@quizmaster/shared/documents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../testing/index.ts";
import { MASS_RETIRE_THRESHOLD, SeedAbortError, seedCatalog } from "./apply.ts";
import { canonicalJson, questionContentHash } from "./content-hash.ts";
import { countPlanChanges, type ExistingState, planSeed, type SeedInput, SeedInputError } from "./plan.ts";

const now = new Date("2026-09-30T19:00:00Z");
const later = new Date("2026-09-30T20:00:00Z");

function categoriesFile(minPlayable = 3): CategoriesFile {
  const topic = (id: string) => ({ id, name: `Thema ${id}`, target: 5, method: "ki" as const });
  const category = (slug: "comics" | "kinofilme", order: number) => ({
    slug,
    name: slug === "comics" ? "Comics" : "Kinofilme",
    icon: slug === "comics" ? "message-circle" : "clapperboard",
    color: slug === "comics" ? "#F7DF45" : "#EE5858",
    order,
    active: true,
    description: "Testkategorie",
    scope: "Test",
    notScope: "Test",
    targets: { start: 10, ausbau: 20 },
    rules: [],
    topics: [topic("grundlagen"), topic("zahlen")],
  });
  return categoriesFileSchema.parse({
    version: 1,
    updated: "2026-09-30",
    note: "Test",
    targets: { start: 10, ausbau: 20, minPlayable },
    difficultyMix: { "1": 0.2, "2": 0.3, "3": 0.25, "4": 0.15, "5": 0.1 },
    methods: { ki: "k", wikidata: "w", prozedural: "p", mix: "m" },
    categories: [category("comics", 1), category("kinofilme", 2)],
  });
}

function entry(id: string, overrides: Record<string, unknown> = {}): QuestionFileEntry {
  return questionFileEntrySchema.parse({
    id,
    difficulty: 2,
    prompt: `Seed-Testfrage ${id}?`,
    answers: ["Richtig", "Falsch 1", "Falsch 2", "Falsch 3"],
    status: "unverified",
    ...overrides,
  });
}

/** 4 Comics- und 4 Kinofilme-Fragen. */
function catalog(patch: (questions: SeedInput["questions"][number][]) => void = () => undefined): SeedInput {
  const questions: SeedInput["questions"][number][] = [];
  for (let n = 1; n <= 4; n++) {
    questions.push({ category: "comics", topic: "grundlagen", entry: entry(`co-seed000${n}`) });
    questions.push({ category: "kinofilme", topic: "zahlen", entry: entry(`kf-seed000${n}`) });
  }
  patch(questions);
  return { categoriesFile: categoriesFile(), questions };
}

const emptyState: ExistingState = { questions: [], categories: [], catalog: null };

describe("contentHash", () => {
  it("ist unabhängig von der Schlüssel-Reihenfolge und erkennt jede Änderung inkl. status", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
    const base = entry("co-hash0001");
    const hash = questionContentHash("comics", "grundlagen", base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(questionContentHash("comics", "grundlagen", { ...base })).toBe(hash);
    expect(questionContentHash("comics", "grundlagen", { ...base, status: "approved" })).not.toBe(hash);
    expect(questionContentHash("comics", "zahlen", base)).not.toBe(hash);
    expect(questionContentHash("comics", "grundlagen", { ...base, explanation: "Zusatz" })).not.toBe(hash);
  });
});

describe("planSeed (rein)", () => {
  it("leere Datenbank: alles neu, Zähler und Katalog-Konfiguration", () => {
    const plan = planSeed(catalog(), emptyState, { pool: "all", now });
    expect(plan.inserts).toHaveLength(8);
    expect(plan.inserts[0]).toMatchObject({ version: 1, status: "unverified", autoRetired: null, lang: "de" });
    expect(
      plan.categoryChanges.map((change) => [change.slug, change.fields.playableCount, change.fields.playable]),
    ).toEqual([
      ["comics", 4, true],
      ["kinofilme", 4, true],
    ]);
    expect(plan.catalog).toEqual({
      config: { minPlayable: 3, difficultyMix: categoriesFile().difficultyMix },
      changed: true,
    });
    expect(plan.totals).toMatchObject({ questions: 8, playable: 8, categories: 2, playableCategories: 2 });
    expect(countPlanChanges(plan)).toBe(11);
  });

  it("verweigert inkonsistente Eingaben", () => {
    const duplicate = catalog((questions) => {
      questions.push({ category: "comics", topic: "grundlagen", entry: entry("co-seed0001") });
    });
    expect(() => planSeed(duplicate, emptyState, { pool: "all", now })).toThrow(SeedInputError);
    const unknownTopic = catalog((questions) => {
      questions.push({ category: "comics", topic: "gibtsnicht", entry: entry("co-seed0009") });
    });
    expect(() => planSeed(unknownTopic, emptyState, { pool: "all", now })).toThrow(/Thema/);
  });

  it("needs_fix/retired im Repo und verschwundene Fragen werden retired, neue inaktive übersprungen", () => {
    const first = planSeed(catalog(), emptyState, { pool: "all", now });
    const existing: ExistingState = {
      questions: first.inserts.map((doc) => ({
        _id: doc._id,
        category: doc.category,
        status: doc.status,
        contentHash: doc.contentHash,
        autoRetired: null,
      })),
      categories: [],
      catalog: first.catalog.config,
    };
    const changed = catalog((questions) => {
      const index = questions.findIndex((q) => q.entry.id === "co-seed0001");
      const target = questions[index];
      if (target) {
        target.entry = entry("co-seed0001", {
          status: "needs_fix",
          review: { checkedAt: "2026-09-30", checkedBy: "fakten-pruefer", notes: "falsch" },
        });
      }
      questions.splice(
        questions.findIndex((q) => q.entry.id === "kf-seed0004"),
        1,
      );
      questions.push({ category: "comics", topic: "zahlen", entry: entry("co-seed0009", { status: "retired" }) });
    });
    const plan = planSeed(changed, existing, { pool: "all", now: later });
    expect(plan.contentUpdates.map((u) => [u.id, u.status])).toEqual([["co-seed0001", "retired"]]);
    expect(plan.removals.map((r) => r.id)).toEqual(["kf-seed0004"]);
    expect(plan.skippedInactive).toBe(1);
    expect(plan.massRetire).toEqual({ retiring: 2, playableBefore: 8, ratio: 0.25 });
  });

  it("autoRetired bleibt bis zur Änderung im Repo; wieder aufgetauchte Fragen werden reaktiviert", () => {
    const input = catalog();
    const base = planSeed(input, emptyState, { pool: "all", now });
    const state = (id: string, patch: Partial<ExistingState["questions"][number]>) => {
      const doc = base.inserts.find((d) => d._id === id);
      if (!doc) throw new Error(id);
      return {
        _id: id,
        category: doc.category,
        status: doc.status,
        contentHash: doc.contentHash,
        autoRetired: null,
        ...patch,
      };
    };
    const existing: ExistingState = {
      questions: [
        ...base.inserts.map((doc) => state(doc._id, {})).filter((q) => !["co-seed0001", "co-seed0002"].includes(q._id)),
        state("co-seed0001", { status: "retired", autoRetired: { reason: "reports", at: now } }),
        state("co-seed0002", { status: "retired" }),
      ],
      categories: [],
      catalog: null,
    };
    const unchangedRepo = planSeed(input, existing, { pool: "all", now: later });
    expect(unchangedRepo.keptAutoRetired).toBe(1);
    expect(unchangedRepo.statusChanges).toEqual([
      { id: "co-seed0002", previousStatus: "retired", status: "unverified" },
    ]);

    const edited = catalog((questions) => {
      const target = questions.find((q) => q.entry.id === "co-seed0001");
      if (target) target.entry = entry("co-seed0001", { prompt: "Korrigierte Seed-Testfrage?" });
    });
    const plan = planSeed(edited, existing, { pool: "all", now: later });
    expect(plan.contentUpdates.map((u) => [u.id, u.status])).toEqual([["co-seed0001", "unverified"]]);
    expect(plan.keptAutoRetired).toBe(0);
  });

  it("playable berücksichtigt minPlayable und QUESTION_POOL=approved", () => {
    const input = catalog((questions) => {
      const target = questions.find((q) => q.entry.id === "co-seed0001");
      if (target) {
        target.entry = entry("co-seed0001", {
          status: "approved",
          source: "https://example.org/beleg",
          review: { checkedAt: "2026-09-30", checkedBy: "fakten-pruefer", notes: null },
        });
      }
    });
    const plan = planSeed(input, emptyState, { pool: "approved", now });
    const comics = plan.categoryChanges.find((change) => change.slug === "comics");
    expect(comics?.fields).toMatchObject({ playableCount: 4, approvedCount: 1, playable: false });
  });
});

describe("seedCatalog (Integration über den Harness)", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  it("Dry-Run schreibt nichts – auch keine Collections", async () => {
    const result = await seedCatalog(t.db, catalog(), { prefix: t.prefix, dryRun: true, now });
    expect(result.changes).toBe(11);
    const names = await t.db.listCollections({ name: { $regex: `^${t.prefix}` } }, { nameOnly: true }).toArray();
    expect(names).toHaveLength(0);
  });

  it("seedet idempotent: zweiter Lauf 0 Änderungen", async () => {
    const first = await seedCatalog(t.db, catalog(), { prefix: t.prefix, now });
    expect(first.written).toMatchObject({ inserted: 8, categoriesWritten: 2, catalogWritten: true, conflicts: 0 });
    expect(first.after).toEqual({ questions: 8, byStatus: { unverified: 8 }, categories: 2, playableCategories: 2 });
    expect(first.indexes?.questionsValidator).toBe("created");
    const again = await seedCatalog(t.db, catalog(), { prefix: t.prefix, dryRun: true, now: later });
    expect(again.changes).toBe(0);
    const real = await seedCatalog(t.db, catalog(), { prefix: t.prefix, now: later });
    expect(real.changes).toBe(0);
    const config = await t.collections.appConfig.findOne({ _id: APP_CONFIG_ID });
    expect(config?.catalog?.minPlayable).toBe(3);
  });

  it("Inhaltsänderung → version++, Statistik bleibt erhalten", async () => {
    await t.collections.questions.updateOne({ _id: "co-seed0003" }, { $set: { "stats.shown": 7 } });
    const edited = catalog((questions) => {
      const target = questions.find((q) => q.entry.id === "co-seed0003");
      if (target) target.entry = entry("co-seed0003", { difficulty: 4, explanation: "Neu erklärt." });
    });
    const result = await seedCatalog(t.db, edited, { prefix: t.prefix, now: later });
    expect(result.written?.contentUpdated).toBe(1);
    const doc = await t.collections.questions.findOne({ _id: "co-seed0003" });
    expect(doc).toMatchObject({ version: 2, difficulty: 4, explanation: "Neu erklärt.", stats: { shown: 7 } });
    expect(doc?.createdAt).toEqual(now);
    expect(doc?.updatedAt).toEqual(later);
  });

  it("Sicherheitsnetz: > 5 % Retire bricht ab (auch im Dry-Run), --allow-mass-retire erlaubt es", async () => {
    expect(MASS_RETIRE_THRESHOLD).toBe(0.05);
    const reduced = catalog((questions) => {
      questions.splice(0, 2);
    });
    await expect(seedCatalog(t.db, reduced, { prefix: t.prefix, dryRun: true })).rejects.toBeInstanceOf(SeedAbortError);
    await expect(seedCatalog(t.db, reduced, { prefix: t.prefix })).rejects.toMatchObject({ code: "MASS_RETIRE" });
    expect(await t.collections.questions.countDocuments({ status: "retired" })).toBe(0);
    const allowed = await seedCatalog(t.db, reduced, { prefix: t.prefix, allowMassRetire: true, now: later });
    expect(allowed.written?.retired).toBe(2);
    expect(await t.collections.questions.countDocuments()).toBe(8);
    expect(await t.collections.questions.countDocuments({ status: "retired" })).toBe(2);
  });
});
