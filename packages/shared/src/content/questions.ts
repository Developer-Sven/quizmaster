/**
 * Fragen-Dateien `content/questions/<kategorie>/<thema>.json` (docs/08 §3). Entspricht
 * `content/schema/question-file.schema.json`; KONVENTION: `answers[0]` ist die richtige Antwort,
 * der Server mischt vor dem Anzeigen (ADR-007).
 */
import { z } from "zod";
import { DIFFICULTIES } from "../constants.ts";
import { FLAG_CODE_REGEX } from "../primitives.ts";

/** Die 19 Kategorien (ADR-015) in der Reihenfolge von `content/categories.json`. */
export const CATEGORY_SLUGS = [
  "buecher-woerter",
  "comics",
  "computerspiele",
  "die-2000er",
  "draussen-im-gruenen",
  "essen-trinken",
  "glaube-religion",
  "im-labor",
  "kinofilme",
  "koerper-geist",
  "kunst-kultur",
  "macht-geld",
  "medien-unterhaltung",
  "musik-hits",
  "rund-um-die-welt",
  "sport-freizeit",
  "tv-serien",
  "wunder-der-technik",
  "zeugen-der-zeit",
] as const;
export type CategorySlug = (typeof CATEGORY_SLUGS)[number];

/** Kategoriekürzel für Fragen-IDs (docs/08 §3). */
export const CATEGORY_ID_PREFIXES: Readonly<Record<CategorySlug, string>> = {
  "buecher-woerter": "bw",
  comics: "co",
  computerspiele: "cs",
  "die-2000er": "ze",
  "draussen-im-gruenen": "dg",
  "essen-trinken": "et",
  "glaube-religion": "gr",
  "im-labor": "il",
  kinofilme: "kf",
  "koerper-geist": "kg",
  "kunst-kultur": "kk",
  "macht-geld": "mg",
  "medien-unterhaltung": "mu",
  "musik-hits": "mh",
  "rund-um-die-welt": "rw",
  "sport-freizeit": "sf",
  "tv-serien": "tv",
  "wunder-der-technik": "wt",
  "zeugen-der-zeit": "zz",
};

/** Fragen-ID `<Kürzel>-<8 Zeichen a–z0–9>`, stabil, nie wiederverwendet. */
export const QUESTION_ID_REGEX = /^(bw|co|cs|ze|dg|et|gr|il|kf|kg|kk|mg|mu|mh|rw|sf|tv|wt|zz)-[a-z0-9]{8}$/;
/** Themen-ID aus `categories.json` (z. B. „hauptstaedte“). */
export const TOPIC_ID_REGEX = /^[a-z0-9-]+$/;

export const QUESTION_FILE_STATUSES = ["unverified", "approved", "needs_fix", "retired"] as const;
export type QuestionFileStatus = (typeof QUESTION_FILE_STATUSES)[number];

/** `asc` = Antworten aufsteigend anzeigen (Zahlen/Jahre), sonst gemischt. */
export const DISPLAY_ORDERS = ["asc", "shuffle"] as const;
export type DisplayOrder = (typeof DISPLAY_ORDERS)[number];

export const PROMPT_MIN_LENGTH = 10;
export const PROMPT_MAX_LENGTH = 140;
export const ANSWER_MAX_LENGTH = 40;
export const EXPLANATION_MAX_LENGTH = 200;

export const reviewInfoSchema = z.strictObject({
  checkedAt: z.iso.date(),
  checkedBy: z.string(),
  notes: z.string().nullable().optional(),
});
export type ReviewInfo = z.output<typeof reviewInfoSchema>;

/** Schwierigkeit 1–5. */
export const difficultySchema = z.literal(DIFFICULTIES);

/** https-URL des Belegs (Pflicht bei `approved`). */
export const sourceUrlSchema = z.string().regex(/^https:\/\//);

const answerSchema = z.string().min(1).max(ANSWER_MAX_LENGTH);

/** Genau 4 Antworten, eindeutig; `answers[0]` ist richtig. */
export const questionAnswersSchema = z.tuple([answerSchema, answerSchema, answerSchema, answerSchema]);

/** Flaggen-Medium einer Frage. */
export const questionMediaSchema = z.strictObject({
  kind: z.literal("flag"),
  code: z.string().regex(FLAG_CODE_REGEX),
});

/** Eine Frage in einer Themen-Datei (ohne die bedingten Regeln, siehe `questionFileEntrySchema`). */
export const questionFileEntryBaseSchema = z.strictObject({
  id: z.string().regex(QUESTION_ID_REGEX),
  difficulty: difficultySchema,
  prompt: z.string().min(PROMPT_MIN_LENGTH).max(PROMPT_MAX_LENGTH).regex(/\?$/),
  answers: questionAnswersSchema,
  status: z.enum(QUESTION_FILE_STATUSES),
  media: questionMediaSchema.optional(),
  displayOrder: z.enum(DISPLAY_ORDERS).optional(),
  explanation: z.string().max(EXPLANATION_MAX_LENGTH).optional(),
  source: sourceUrlSchema.optional(),
  volatile: z.boolean().optional(),
  asOf: z.iso.date().optional(),
  review: reviewInfoSchema.optional(),
});

/**
 * Eine Frage inkl. der bedingten Regeln aus dem JSON-Schema: Antworten eindeutig; `approved` braucht
 * `source` + `review`; `needs_fix` braucht `review`; `volatile: true` braucht `asOf`.
 */
export const questionFileEntrySchema = questionFileEntryBaseSchema.superRefine((question, ctx) => {
  if (new Set(question.answers).size !== question.answers.length) {
    ctx.addIssue({ code: "custom", message: "Antworten müssen eindeutig sein", path: ["answers"] });
  }
  if (question.status === "approved") {
    if (question.source === undefined) {
      ctx.addIssue({ code: "custom", message: "approved braucht source", path: ["source"] });
    }
    if (question.review === undefined) {
      ctx.addIssue({ code: "custom", message: "approved braucht review", path: ["review"] });
    }
  }
  if (question.status === "needs_fix" && question.review === undefined) {
    ctx.addIssue({ code: "custom", message: "needs_fix braucht review", path: ["review"] });
  }
  if (question.volatile === true && question.asOf === undefined) {
    ctx.addIssue({ code: "custom", message: "volatile braucht asOf", path: ["asOf"] });
  }
});
export type QuestionFileEntry = z.output<typeof questionFileEntrySchema>;

/** Eine Themen-Datei. */
export const questionFileSchema = z.strictObject({
  category: z.enum(CATEGORY_SLUGS),
  topic: z.string().regex(TOPIC_ID_REGEX),
  questions: z.array(questionFileEntrySchema).min(1),
});
export type QuestionFile = z.output<typeof questionFileSchema>;

/** true, wenn das ID-Kürzel zur Kategorie passt (Regel aus docs/08 §3, nicht Teil des JSON-Schemas). */
export function questionIdMatchesCategory(id: string, category: CategorySlug): boolean {
  return id.startsWith(`${CATEGORY_ID_PREFIXES[category]}-`);
}

/** Status in der Datenbank: `needs_fix`/`retired` im Repo → `retired` in der DB (docs/04 §Seed). */
export const QUESTION_DB_STATUSES = ["unverified", "approved", "retired"] as const;
export type QuestionDbStatus = (typeof QUESTION_DB_STATUSES)[number];

export function toDbQuestionStatus(status: QuestionFileStatus): QuestionDbStatus {
  return status === "needs_fix" ? "retired" : status;
}

/** Spielbar sind `unverified` + `approved` (QUESTION_POOL=all) bzw. nur `approved` (QUESTION_POOL=approved). */
export function isPlayableStatus(status: QuestionDbStatus, pool: "all" | "approved"): boolean {
  return pool === "approved" ? status === "approved" : status !== "retired";
}
