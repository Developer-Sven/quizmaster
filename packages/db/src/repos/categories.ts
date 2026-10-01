/**
 * categories (docs/04): Spiegel von `content/categories.json` + berechnete Zähler. Geschrieben vom
 * Seed; `playableCount`/`approvedCount`/`playable` zusätzlich live vom Realtime-Server nach Statusänderungen
 * (Schutzautomatik) bzw. von `admin:reports --restore` – `recountCategory` zählt die Fragen der Kategorie neu
 * (Index `status_category_difficulty`) und setzt `playable` mit der Mindestmenge aus `appConfig.catalog`
 * (ADR-021). Der Kategorien-Watcher übernimmt `playable` sofort: Kategorien unter der Mindestmenge werden nicht
 * mehr angeboten.
 */
import { categoryIdSchema } from "@quizmaster/shared";
import type { CategoryDoc } from "@quizmaster/shared/documents";
import type { Collection } from "mongodb";
import { z } from "zod";
import { HOT_PATH_TIMEOUT_MS, USER_READ_MAX_TIME_MS } from "../client.ts";
import type { PlayableCounts, QuestionPool, QuestionsRepo } from "./questions.ts";

export const categoryCountsSchema = z.strictObject({
  playableCount: z.int().min(0),
  approvedCount: z.int().min(0),
  playable: z.boolean(),
});
export type CategoryCounts = z.output<typeof categoryCountsSchema>;

const playableCountsSchema = z.strictObject({ playableCount: z.int().min(0), approvedCount: z.int().min(0) });

/** Regel für `playable`: Mindestmenge (`appConfig.catalog.minPlayable`) und Fragenpool (QUESTION_POOL). */
export const playableRuleSchema = z.strictObject({
  minPlayable: z.int().min(1),
  pool: z.enum(["all", "approved"]),
});
export type PlayableRule = z.output<typeof playableRuleSchema>;

/** Zähler-Stand einer Kategorie vor bzw. nach einer Neuberechnung. */
export interface CategoryCountState extends CategoryCounts {
  active: boolean;
}

export interface CategoryRecount {
  categoryId: string;
  before: CategoryCountState;
  after: CategoryCountState;
}

/**
 * Spielbar: aktiv und genug spielbare Fragen (QUESTION_POOL=approved → nur `approvedCount`).
 * `minPlayable` stammt aus `appConfig.catalog` (ADR-021).
 */
export function isCategoryPlayable(
  counts: { active: boolean; playableCount: number; approvedCount: number },
  minPlayable: number,
  pool: "all" | "approved",
): boolean {
  const count = pool === "approved" ? counts.approvedCount : counts.playableCount;
  return counts.active && count >= minPlayable;
}

export interface CategoriesRepo {
  /** Alle Kategorien nach `order`. */
  listAll(): Promise<CategoryDoc[]>;
  /** Spielbare Kategorien nach `order` (Index `playable + order`). */
  listPlayable(): Promise<CategoryDoc[]>;
  findById(slug: string): Promise<CategoryDoc | null>;
  /** Zähler setzen (Realtime nach Pool-Änderungen); `false`, wenn die Kategorie fehlt. */
  updateCounts(slug: string, counts: CategoryCounts, now: Date): Promise<boolean>;
  /**
   * Zähler setzen und `playable` atomar aus dem aktuellen `active`-Flag berechnen (Update-Pipeline – ein
   * paralleles Deaktivieren geht nicht verloren). `null`, wenn die Kategorie fehlt.
   */
  applyCounts(slug: string, counts: PlayableCounts, rule: PlayableRule, now: Date): Promise<CategoryRecount | null>;
}

const COUNT_STATE_PROJECTION = { _id: 1, active: 1, playable: 1, playableCount: 1, approvedCount: 1 } as const;

export function createCategoriesRepo(categories: Collection<CategoryDoc>): CategoriesRepo {
  return {
    async listAll() {
      return categories.find({}).sort({ order: 1 }).toArray();
    },

    async listPlayable() {
      return categories.find({ playable: true }, { maxTimeMS: USER_READ_MAX_TIME_MS }).sort({ order: 1 }).toArray();
    },

    async findById(slug) {
      return categories.findOne({ _id: categoryIdSchema.parse(slug) });
    },

    async updateCounts(slug, counts, now) {
      const parsed = categoryCountsSchema.parse(counts);
      const result = await categories.updateOne(
        { _id: categoryIdSchema.parse(slug) },
        { $set: { ...parsed, updatedAt: now } },
      );
      return result.matchedCount === 1;
    },

    async applyCounts(slug, counts, rule, now) {
      const id = categoryIdSchema.parse(slug);
      const parsed = playableCountsSchema.parse(counts);
      const { minPlayable, pool } = playableRuleSchema.parse(rule);
      const enough = (pool === "approved" ? parsed.approvedCount : parsed.playableCount) >= minPlayable;
      const before = await categories.findOneAndUpdate(
        { _id: id },
        [
          {
            $set: {
              playableCount: parsed.playableCount,
              approvedCount: parsed.approvedCount,
              playable: { $and: [{ $eq: ["$active", true] }, enough] },
              updatedAt: now,
            },
          },
        ],
        { returnDocument: "before", projection: COUNT_STATE_PROJECTION, timeoutMS: HOT_PATH_TIMEOUT_MS },
      );
      if (before === null) return null;
      const active = before.active === true;
      return {
        categoryId: id,
        before: {
          active,
          playable: before.playable,
          playableCount: before.playableCount,
          approvedCount: before.approvedCount,
        },
        after: { active, playable: active && enough, ...parsed },
      };
    },
  };
}

/**
 * Zählt die Fragen einer Kategorie neu und setzt `playableCount`, `approvedCount` und `playable` (Live-Zähler
 * nach Statusänderungen). `null`, wenn die Kategorie fehlt.
 */
export async function recountCategory(
  repos: { questions: Pick<QuestionsRepo, "countPlayable">; categories: Pick<CategoriesRepo, "applyCounts"> },
  slug: string,
  rule: { minPlayable: number; pool: QuestionPool },
  now: Date,
): Promise<CategoryRecount | null> {
  const counts = await repos.questions.countPlayable(slug);
  return repos.categories.applyCounts(slug, counts, rule, now);
}
