/**
 * Struktur von `content/categories.json` (docs/08 §1): Kategorien, Abgrenzung, Themenplan, Katalog-Ziele.
 * `targets.minPlayable` und `difficultyMix` landen beim Seed in `appConfig.catalog` (ADR-021) –
 * Realtime liest nie `content/`.
 */
import { z } from "zod";
import { hexColorSchema, iconNameSchema } from "../primitives.ts";
import { CATEGORY_SLUGS, TOPIC_ID_REGEX } from "./questions.ts";

/** Erstellungsmethoden je Thema. */
export const TOPIC_METHODS = ["ki", "wikidata", "prozedural", "mix"] as const;
export type TopicMethod = (typeof TOPIC_METHODS)[number];

const share = z.number().min(0).max(1);

/** Schwierigkeitsmix (Anteile je Stufe 1–5, Summe ≈ 1), Schlüssel als Strings wie in der JSON-Datei. */
export const difficultyMixSchema = z
  .strictObject({ "1": share, "2": share, "3": share, "4": share, "5": share })
  .refine((mix) => Math.abs(Object.values(mix).reduce((sum, value) => sum + value, 0) - 1) < 0.001, {
    message: "Anteile müssen sich zu 1 summieren",
  });
export type DifficultyMix = z.output<typeof difficultyMixSchema>;

/** Standard-Mix aus `content/categories.json` (Ziel 20/30/25/15/10). */
export const DEFAULT_DIFFICULTY_MIX: Readonly<DifficultyMix> = Object.freeze({
  "1": 0.2,
  "2": 0.3,
  "3": 0.25,
  "4": 0.15,
  "5": 0.1,
});

/** Kategorie spielbar ab so vielen Fragen (docs/08 §4, `targets.minPlayable`). */
export const DEFAULT_MIN_PLAYABLE = 100;

export const categoryTopicSchema = z.strictObject({
  id: z.string().regex(TOPIC_ID_REGEX),
  name: z.string().min(1).max(100),
  target: z.int().min(0),
  method: z.enum(TOPIC_METHODS),
});
export type CategoryTopic = z.output<typeof categoryTopicSchema>;

export const categoryEntrySchema = z
  .strictObject({
    slug: z.enum(CATEGORY_SLUGS),
    /** Exakt wie beim Vorbild (Quizduell-Namen). */
    name: z.string().min(1).max(64),
    icon: iconNameSchema,
    color: hexColorSchema,
    order: z.int().min(1),
    active: z.boolean(),
    description: z.string().min(1).max(200),
    scope: z.string().min(1).max(1_000),
    notScope: z.string().min(1).max(1_000),
    targets: z.strictObject({ start: z.int().min(0), ausbau: z.int().min(0) }),
    rules: z.array(z.string().min(1).max(500)),
    topics: z.array(categoryTopicSchema).min(1),
  })
  .refine((category) => new Set(category.topics.map((topic) => topic.id)).size === category.topics.length, {
    message: "Themen-IDs müssen je Kategorie eindeutig sein",
    path: ["topics"],
  });
export type CategoryEntry = z.output<typeof categoryEntrySchema>;

export const categoriesFileSchema = z
  .strictObject({
    version: z.int().min(1),
    updated: z.iso.date(),
    note: z.string(),
    targets: z.strictObject({ start: z.int().min(0), ausbau: z.int().min(0), minPlayable: z.int().min(1) }),
    difficultyMix: difficultyMixSchema,
    methods: z.record(z.enum(TOPIC_METHODS), z.string()),
    categories: z.array(categoryEntrySchema).min(1),
  })
  .superRefine((file, ctx) => {
    const slugs = file.categories.map((category) => category.slug);
    if (new Set(slugs).size !== slugs.length) {
      ctx.addIssue({ code: "custom", message: "Kategorie-Slugs müssen eindeutig sein", path: ["categories"] });
    }
    const orders = file.categories.map((category) => category.order);
    if (new Set(orders).size !== orders.length) {
      ctx.addIssue({ code: "custom", message: "order muss eindeutig sein", path: ["categories"] });
    }
  });
export type CategoriesFile = z.output<typeof categoriesFileSchema>;
