/**
 * Öffentliche Kategorienliste (docs/02: „Kategorienliste für Einstellungen“, docs/07 §Caching): nur
 * spielbare Kategorien, per Projektion nur die öffentlichen Felder (docs/07: „Projektionen: immer nur
 * benötigte Felder“; ADR-021), kurz im Prozess gecacht – davor cacht das CDN (s-maxage=300).
 */
import { USER_READ_MAX_TIME_MS } from "@quizmaster/db";
import type { CategoryDoc } from "@quizmaster/shared/documents";
import type { Collection } from "mongodb";
import type { Logger } from "pino";
import { type PublicCategory, publicCategorySchema } from "./api-schemas";

export const CATEGORIES_CACHE_MS = 30_000;

type CategoryProjection = Pick<CategoryDoc, "_id" | "name" | "icon" | "color" | "order">;

/**
 * Explizites Mapping (kein Spread) – private Felder können so nie durchrutschen. `null`, wenn das Dokument
 * nicht dem öffentlichen Vertrag entspricht (wird dann ausgelassen statt ungeprüft ausgeliefert).
 */
export function toPublicCategory(doc: CategoryProjection): PublicCategory | null {
  const parsed = publicCategorySchema.safeParse({
    id: doc._id,
    name: doc.name,
    icon: doc.icon,
    color: doc.color,
    order: doc.order,
  });
  return parsed.success ? parsed.data : null;
}

export interface CategoryCatalog {
  listPlayable(): Promise<PublicCategory[]>;
}

export interface CategoryCatalogOptions {
  logger: Logger;
  now?: () => number;
  cacheMs?: number;
}

export function createCategoryCatalog(
  categories: Collection<CategoryDoc>,
  options: CategoryCatalogOptions,
): CategoryCatalog {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? CATEGORIES_CACHE_MS;
  let cached: { list: PublicCategory[]; at: number } | undefined;
  let inflight: Promise<PublicCategory[]> | undefined;

  const load = async (): Promise<PublicCategory[]> => {
    const docs = await categories
      .find<CategoryProjection>(
        { playable: true },
        { projection: { _id: 1, name: 1, icon: 1, color: 1, order: 1 }, maxTimeMS: USER_READ_MAX_TIME_MS },
      )
      .sort({ order: 1 })
      .toArray();
    const list: PublicCategory[] = [];
    for (const doc of docs) {
      const category = toPublicCategory(doc);
      if (category === null) {
        options.logger.error(
          { categoryId: String(doc._id) },
          "Kategorie verletzt den öffentlichen Vertrag – ausgelassen",
        );
      } else {
        list.push(category);
      }
    }
    cached = { list, at: now() };
    return list;
  };

  return {
    listPlayable() {
      if (cached !== undefined && now() - cached.at < cacheMs) return Promise.resolve(cached.list);
      inflight ??= load().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
