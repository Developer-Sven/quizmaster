/**
 * Antwort-Verträge der Web-API, die `@quizmaster/shared/http` (noch) nicht enthält. Reines zod ohne
 * Server-Abhängigkeiten – auch im Client importierbar (z. B. `import type { PublicCategory } …`).
 * Request-Bodys, Ticket-, Health- und Fehlerantworten kommen aus `@quizmaster/shared`.
 */
import { categoryIdSchema, hexColorSchema, iconNameSchema } from "@quizmaster/shared";
import { z } from "zod";

/** `POST /api/session` → 201 (neu angelegt) bzw. 200 (bestehende Session weiterverwendet). */
export const sessionResponseSchema = z.strictObject({ created: z.boolean() });
export type SessionResponse = z.output<typeof sessionResponseSchema>;

/**
 * Öffentliche Kategorie-Felder für die Einstellungen (ADR-021: `scope`, `notScope`, `topics`, Zähler usw.
 * sind privat und verlassen den Server nie).
 */
export const publicCategorySchema = z.strictObject({
  id: categoryIdSchema,
  name: z.string().min(1).max(64),
  icon: iconNameSchema,
  color: hexColorSchema,
  order: z.int().min(1),
});
export type PublicCategory = z.output<typeof publicCategorySchema>;

/** `GET /api/categories` → spielbare Kategorien, nach `order` sortiert. */
export const categoriesResponseSchema = z.strictObject({ categories: z.array(publicCategorySchema) });
export type CategoriesResponse = z.output<typeof categoriesResponseSchema>;
