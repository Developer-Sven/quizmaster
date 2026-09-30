import { z } from "zod";
import { TOPIC_METHODS } from "../content/categories.ts";
import {
  DISPLAY_ORDERS,
  difficultySchema,
  QUESTION_DB_STATUSES,
  QUESTION_ID_REGEX,
  sourceUrlSchema,
  TOPIC_ID_REGEX,
} from "../content/questions.ts";
import { categoryIdSchema, hexColorSchema, iconNameSchema, mediaSchema } from "../primitives.ts";

const count = z.int().min(0);

/** categories – Spiegel von `content/categories.json` + berechnete Felder (dauerhaft). */
export const categoryDocSchema = z.object({
  /** Slug. */
  _id: categoryIdSchema,
  /** Exakt wie in categories.json (Quizduell-Namen). */
  name: z.string().min(1).max(64),
  /** Lucide-Icon-Name. */
  icon: iconNameSchema,
  /** Kategoriefarbe (docs/09). */
  color: hexColorSchema,
  order: z.int().min(1),
  description: z.string(),
  scope: z.string(),
  notScope: z.string(),
  /** Flag aus der JSON-Datei. */
  active: z.boolean(),
  /** unverified + approved (Seed + Change Stream). */
  playableCount: count,
  approvedCount: count,
  /** active && (QUESTION_POOL=approved ? approvedCount : playableCount) >= catalog.minPlayable. */
  playable: z.boolean(),
  topics: z.array(
    z.object({
      id: z.string().regex(TOPIC_ID_REGEX),
      name: z.string().min(1),
      target: count,
      method: z.enum(TOPIC_METHODS),
    }),
  ),
  updatedAt: z.date(),
});
export type CategoryDoc = z.output<typeof categoryDocSchema>;

/** Antworten in Repo-Reihenfolge – KONVENTION: `answers[0]` ist richtig. */
const dbAnswersSchema = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1), z.string().min(1)]);

/** questions – Fragen aus `content/questions/**` + Statistik (dauerhaft, `retired` statt löschen). */
export const questionDocSchema = z.object({
  /** Stabile ID aus der Content-Datei, z. B. „rw-8f3k2m1q“. */
  _id: z.string().regex(QUESTION_ID_REGEX),
  /** Kategorie-Slug. */
  category: categoryIdSchema,
  /** Themen-ID aus categories.json. */
  topic: z.string().regex(TOPIC_ID_REGEX),
  difficulty: difficultySchema,
  prompt: z.string().min(1),
  answers: dbAnswersSchema,
  displayOrder: z.enum(DISPLAY_ORDERS),
  explanation: z.string().nullable(),
  media: mediaSchema,
  volatile: z.boolean(),
  /** ISO-Datum, Pflicht wenn volatile. */
  asOf: z.iso.date().nullable(),
  /** URL des Belegs (Pflicht bei approved). */
  source: sourceUrlSchema.nullable(),
  /** needs_fix im Repo → retired in der DB. */
  status: z.enum(QUESTION_DB_STATUSES),
  /** Schutzautomatik (docs/08 §5). */
  autoRetired: z.object({ reason: z.enum(["reports", "rating"]), at: z.date() }).nullable(),
  lang: z.literal("de"),
  /** sha256 (hex) über ALLE Felder der Frage im Repo – Seed erkennt jede Änderung. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.int().min(1),
  stats: z.object({ shown: count, correct: count, likes: count, dislikes: count, reports: count }),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type QuestionDoc = z.output<typeof questionDocSchema>;
