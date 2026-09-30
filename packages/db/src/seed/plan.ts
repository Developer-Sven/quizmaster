/**
 * Seed-Plan (docs/04 §Seed & Migrationen, docs/08 §4) als reine Funktion: vergleicht den Katalog aus
 * dem Repo mit dem Stand der Datenbank und liefert alle nötigen Änderungen – ohne I/O, dadurch exakt
 * testbar und für `--dry-run` identisch zum echten Lauf.
 *
 * Regeln:
 * - `unverified`/`approved` → Upsert per `_id`, nur bei geänderter `contentHash` (`version++`).
 * - `needs_fix`/`retired` im Repo oder aus dem Repo verschwunden → DB-Status `retired` (nie löschen).
 * - `autoRetired` (Schutzautomatik) bleibt, bis die Frage im Repo geändert wurde (neue `contentHash`).
 * - Zähler je Kategorie (`playableCount`, `approvedCount`, `playable`) aus dem Endzustand.
 * - `minPlayable` + `difficultyMix` → `appConfig.catalog` (ADR-021).
 */

import { isDeepStrictEqual } from "node:util";
import {
  type CategoriesFile,
  type CategorySlug,
  type QuestionDbStatus,
  type QuestionFileEntry,
  toDbQuestionStatus,
} from "@quizmaster/shared/content";
import type { CatalogConfig, CategoryDoc, QuestionDoc } from "@quizmaster/shared/documents";
import { isCategoryPlayable } from "../repos/categories.ts";
import type { QuestionPool } from "../repos/questions.ts";
import { questionContentHash } from "./content-hash.ts";

export interface SeedQuestionInput {
  category: CategorySlug;
  topic: string;
  entry: QuestionFileEntry;
}

/** Validierter Katalog (categories.json + alle Fragen aus allen Themen-Dateien). */
export interface SeedInput {
  categoriesFile: CategoriesFile;
  questions: readonly SeedQuestionInput[];
}

/** Stand einer Frage in der Datenbank (schmale Projektion). */
export type ExistingQuestion = Pick<QuestionDoc, "_id" | "category" | "status" | "contentHash" | "autoRetired">;

export interface ExistingState {
  questions: readonly ExistingQuestion[];
  categories: readonly CategoryDoc[];
  /** `appConfig.catalog` roh aus der DB (`null` = fehlt). */
  catalog: CatalogConfig | null;
}

/** Inhaltsfelder einer Frage (alles außer Status, Statistik und Verwaltung). */
export type QuestionContentFields = Pick<
  QuestionDoc,
  | "category"
  | "topic"
  | "difficulty"
  | "prompt"
  | "answers"
  | "displayOrder"
  | "explanation"
  | "media"
  | "volatile"
  | "asOf"
  | "source"
  | "lang"
>;

export interface QuestionContentUpdate {
  id: string;
  /** Erwarteter Stand in der DB (Schutz gegen parallele Änderungen). */
  previousHash: string;
  previousStatus: QuestionDbStatus;
  fields: QuestionContentFields;
  status: QuestionDbStatus;
  contentHash: string;
}

export interface QuestionStatusChange {
  id: string;
  previousStatus: QuestionDbStatus;
  status: QuestionDbStatus;
}

export type CategoryFields = Omit<CategoryDoc, "_id" | "updatedAt">;

export interface CategoryChange {
  slug: string;
  fields: CategoryFields;
  /** false = neu anlegen. */
  exists: boolean;
}

export interface SeedPlan {
  now: Date;
  inserts: QuestionDoc[];
  contentUpdates: QuestionContentUpdate[];
  /** Nur Statuswechsel ohne Inhaltsänderung (z. B. wieder aufgetaucht oder in der DB abweichend). */
  statusChanges: QuestionStatusChange[];
  /** Aus dem Repo verschwunden und noch nicht retired → retired. */
  removals: QuestionStatusChange[];
  /** Unverändert (inkl. erhaltener autoRetired). */
  unchanged: number;
  /** autoRetired bleibt erhalten, weil die Frage im Repo unverändert ist. */
  keptAutoRetired: number;
  /** needs_fix/retired im Repo, aber nie in der DB → nichts zu tun. */
  skippedInactive: number;
  categoryChanges: CategoryChange[];
  categoriesUnchanged: number;
  catalog: { config: CatalogConfig; changed: boolean };
  /** Spielbare Fragen, die dieser Lauf auf retired setzen würde (Sicherheitsnetz ADR-021). */
  massRetire: { retiring: number; playableBefore: number; ratio: number };
  totals: {
    questions: number;
    playable: number;
    approved: number;
    retired: number;
    categories: number;
    playableCategories: number;
  };
}

/** Anzahl aller Änderungen (0 = Datenbank entspricht dem Repo). */
export function countPlanChanges(plan: SeedPlan): number {
  return (
    plan.inserts.length +
    plan.contentUpdates.length +
    plan.statusChanges.length +
    plan.removals.length +
    plan.categoryChanges.length +
    (plan.catalog.changed ? 1 : 0)
  );
}

export class SeedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedInputError";
  }
}

/** Inhaltsfelder der DB aus einem Eintrag der Themen-Datei. */
export function questionContentFields(input: SeedQuestionInput): QuestionContentFields {
  const { entry } = input;
  return {
    category: input.category,
    topic: input.topic,
    difficulty: entry.difficulty,
    prompt: entry.prompt,
    answers: entry.answers,
    displayOrder: entry.displayOrder ?? "shuffle",
    explanation: entry.explanation ?? null,
    media: entry.media ?? null,
    volatile: entry.volatile ?? false,
    asOf: entry.asOf ?? null,
    source: entry.source ?? null,
    lang: "de",
  };
}

function assertConsistentInput(input: SeedInput): void {
  const topics = new Map(
    input.categoriesFile.categories.map((category) => [category.slug, new Set(category.topics.map((t) => t.id))]),
  );
  const seen = new Set<string>();
  for (const question of input.questions) {
    const id = question.entry.id;
    if (seen.has(id)) throw new SeedInputError(`Fragen-ID doppelt im Katalog: ${id}`);
    seen.add(id);
    const categoryTopics = topics.get(question.category);
    if (categoryTopics === undefined) {
      throw new SeedInputError(`Kategorie „${question.category}“ fehlt in categories.json (${id})`);
    }
    if (!categoryTopics.has(question.topic)) {
      throw new SeedInputError(`Thema „${question.topic}“ fehlt in Kategorie „${question.category}“ (${id})`);
    }
  }
}

interface FinalState {
  category: string;
  status: QuestionDbStatus;
}

export interface PlanOptions {
  pool: QuestionPool;
  now: Date;
}

/** Berechnet alle Änderungen, ohne etwas zu schreiben. */
export function planSeed(input: SeedInput, existing: ExistingState, options: PlanOptions): SeedPlan {
  assertConsistentInput(input);
  const { now } = options;
  const existingById = new Map(existing.questions.map((question) => [question._id, question]));
  const final = new Map<string, FinalState>(
    existing.questions.map((question) => [question._id, { category: question.category, status: question.status }]),
  );

  const plan: SeedPlan = {
    now,
    inserts: [],
    contentUpdates: [],
    statusChanges: [],
    removals: [],
    unchanged: 0,
    keptAutoRetired: 0,
    skippedInactive: 0,
    categoryChanges: [],
    categoriesUnchanged: 0,
    catalog: {
      config: {
        minPlayable: input.categoriesFile.targets.minPlayable,
        difficultyMix: { ...input.categoriesFile.difficultyMix },
      },
      changed: false,
    },
    massRetire: { retiring: 0, playableBefore: 0, ratio: 0 },
    totals: { questions: 0, playable: 0, approved: 0, retired: 0, categories: 0, playableCategories: 0 },
  };

  const inContent = new Set<string>();
  for (const question of input.questions) {
    const id = question.entry.id;
    inContent.add(id);
    const hash = questionContentHash(question.category, question.topic, question.entry);
    const fileStatus = toDbQuestionStatus(question.entry.status);
    const current = existingById.get(id);
    if (current === undefined) {
      if (fileStatus === "retired") {
        plan.skippedInactive += 1;
        continue;
      }
      plan.inserts.push({
        _id: id,
        ...questionContentFields(question),
        status: fileStatus,
        autoRetired: null,
        contentHash: hash,
        version: 1,
        stats: { shown: 0, correct: 0, likes: 0, dislikes: 0, reports: 0 },
        createdAt: now,
        updatedAt: now,
      });
      final.set(id, { category: question.category, status: fileStatus });
      continue;
    }
    if (current.contentHash !== hash) {
      plan.contentUpdates.push({
        id,
        previousHash: current.contentHash,
        previousStatus: current.status,
        fields: questionContentFields(question),
        status: fileStatus,
        contentHash: hash,
      });
      final.set(id, { category: question.category, status: fileStatus });
      continue;
    }
    // Inhalt unverändert: autoRetired bleibt bestehen, sonst gilt der Status aus dem Repo.
    const keepAutoRetired = current.autoRetired !== null;
    const desired: QuestionDbStatus = keepAutoRetired ? "retired" : fileStatus;
    if (current.status !== desired) {
      plan.statusChanges.push({ id, previousStatus: current.status, status: desired });
      final.set(id, { category: current.category, status: desired });
    } else {
      plan.unchanged += 1;
      if (keepAutoRetired) plan.keptAutoRetired += 1;
    }
  }

  for (const question of existing.questions) {
    if (inContent.has(question._id) || question.status === "retired") continue;
    plan.removals.push({ id: question._id, previousStatus: question.status, status: "retired" });
    final.set(question._id, { category: question.category, status: "retired" });
  }

  // Sicherheitsnetz: wie viele bisher spielbare Fragen würden retired?
  const playableBefore = existing.questions.filter((question) => question.status !== "retired").length;
  const retiring =
    plan.removals.length +
    plan.contentUpdates.filter((update) => update.previousStatus !== "retired" && update.status === "retired").length +
    plan.statusChanges.filter((change) => change.previousStatus !== "retired" && change.status === "retired").length;
  plan.massRetire = { retiring, playableBefore, ratio: playableBefore === 0 ? 0 : retiring / playableBefore };

  planCategories(plan, input, existing, final, options);

  plan.catalog.changed = !isDeepStrictEqual(existing.catalog, plan.catalog.config);
  return plan;
}

function planCategories(
  plan: SeedPlan,
  input: SeedInput,
  existing: ExistingState,
  final: Map<string, FinalState>,
  options: PlanOptions,
): void {
  const counts = new Map<string, { playableCount: number; approvedCount: number }>();
  for (const state of final.values()) {
    const entry = counts.get(state.category) ?? { playableCount: 0, approvedCount: 0 };
    if (state.status !== "retired") entry.playableCount += 1;
    if (state.status === "approved") entry.approvedCount += 1;
    counts.set(state.category, entry);
    plan.totals.questions += 1;
    if (state.status !== "retired") plan.totals.playable += 1;
    if (state.status === "approved") plan.totals.approved += 1;
    if (state.status === "retired") plan.totals.retired += 1;
  }

  const minPlayable = input.categoriesFile.targets.minPlayable;
  const existingBySlug = new Map(existing.categories.map((category) => [category._id, category]));
  const desired: Array<{ slug: string; fields: CategoryFields }> = input.categoriesFile.categories.map((category) => {
    const count = counts.get(category.slug) ?? { playableCount: 0, approvedCount: 0 };
    return {
      slug: category.slug,
      fields: {
        name: category.name,
        icon: category.icon,
        color: category.color,
        order: category.order,
        description: category.description,
        scope: category.scope,
        notScope: category.notScope,
        active: category.active,
        playableCount: count.playableCount,
        approvedCount: count.approvedCount,
        playable: isCategoryPlayable({ active: category.active, ...count }, minPlayable, options.pool),
        topics: category.topics.map((topic) => ({
          id: topic.id,
          name: topic.name,
          target: topic.target,
          method: topic.method,
        })),
      },
    };
  });
  // Kategorien, die aus categories.json verschwunden sind: deaktivieren, nie löschen.
  const inFile = new Set<string>(input.categoriesFile.categories.map((category) => category.slug));
  for (const category of existing.categories) {
    if (inFile.has(category._id)) continue;
    const count = counts.get(category._id) ?? { playableCount: 0, approvedCount: 0 };
    const { _id, updatedAt: _updatedAt, ...rest } = category;
    desired.push({ slug: _id, fields: { ...rest, active: false, ...count, playable: false } });
  }

  for (const { slug, fields } of desired) {
    const current = existingBySlug.get(slug);
    if (fields.active && fields.playable) plan.totals.playableCategories += 1;
    plan.totals.categories += 1;
    if (current === undefined) {
      plan.categoryChanges.push({ slug, fields, exists: false });
      continue;
    }
    if (sameFields(current, fields)) plan.categoriesUnchanged += 1;
    else plan.categoryChanges.push({ slug, fields, exists: true });
  }
}

/** Vergleicht nur die vom Seed verwalteten Felder (zusätzliche Felder in der DB stören nicht). */
function sameFields(current: CategoryDoc, fields: CategoryFields): boolean {
  const record = current as unknown as Record<string, unknown>;
  return Object.entries(fields).every(([key, value]) => isDeepStrictEqual(record[key], value));
}
