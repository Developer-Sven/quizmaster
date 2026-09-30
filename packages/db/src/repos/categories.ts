/**
 * categories (docs/04): Spiegel von `content/categories.json` + berechnete Zähler. Geschrieben vom
 * Seed; `playableCount`/`approvedCount`/`playable` zusätzlich live vom Realtime-Server (Change Stream).
 */
import { categoryIdSchema } from "@quizmaster/shared";
import type { CategoryDoc } from "@quizmaster/shared/documents";
import type { Collection } from "mongodb";
import { z } from "zod";

export const categoryCountsSchema = z.strictObject({
  playableCount: z.int().min(0),
  approvedCount: z.int().min(0),
  playable: z.boolean(),
});
export type CategoryCounts = z.output<typeof categoryCountsSchema>;

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
}

export function createCategoriesRepo(categories: Collection<CategoryDoc>): CategoriesRepo {
  return {
    async listAll() {
      return categories.find({}).sort({ order: 1 }).toArray();
    },

    async listPlayable() {
      return categories.find({ playable: true }).sort({ order: 1 }).toArray();
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
  };
}
