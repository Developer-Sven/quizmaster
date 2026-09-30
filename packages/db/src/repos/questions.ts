/**
 * questions (docs/04 §Fragenauswahl): Pool laden mit schmaler Projektion (Index
 * `status + category + difficulty`), Voll-Dokumente der gezogenen Fragen per `$in`, inkrementeller
 * Reload über `updatedAt`, Statistik per `bulkWrite` (`ordered: false`) und die Schutzautomatik
 * (docs/08 §5: sofort `retired` + `autoRetired`).
 */
import type { QuestionDbStatus } from "@quizmaster/shared/content";
import type { QuestionDoc } from "@quizmaster/shared/documents";
import type { AnyBulkWriteOperation, ClientSession, Collection } from "mongodb";
import { z } from "zod";
import { chunk, questionIdSchema, uniqueIds } from "./ids.ts";

export type QuestionPool = "all" | "approved";

/** Statuswerte, die im Spiel gezogen werden (QUESTION_POOL, docs/02). */
export function playableStatuses(pool: QuestionPool): QuestionDbStatus[] {
  return pool === "approved" ? ["approved"] : ["unverified", "approved"];
}

/** Pool-Eintrag im Speicher des Realtime-Servers (nur IDs + Auswahlkriterien). */
export type PoolEntry = Pick<QuestionDoc, "_id" | "category" | "topic" | "difficulty">;
export const POOL_PROJECTION = { _id: 1, category: 1, topic: 1, difficulty: 1 } as const;

/** Felder, die das Spiel von einer gezogenen Frage braucht (ohne Statistik/Hash/Verwaltung). */
export type PlayQuestion = Pick<
  QuestionDoc,
  | "_id"
  | "category"
  | "topic"
  | "difficulty"
  | "prompt"
  | "answers"
  | "displayOrder"
  | "explanation"
  | "media"
  | "source"
  | "status"
>;
export const PLAY_PROJECTION = {
  _id: 1,
  category: 1,
  topic: 1,
  difficulty: 1,
  prompt: 1,
  answers: 1,
  displayOrder: 1,
  explanation: 1,
  media: 1,
  source: 1,
  status: 1,
} as const;

/** Änderung seit einem Zeitpunkt (inkrementeller Reload): Pool-Felder + Status. */
export type QuestionChange = PoolEntry & Pick<QuestionDoc, "status" | "updatedAt">;

export const questionStatsDeltaSchema = z.strictObject({
  questionId: questionIdSchema,
  shown: z.int().min(0).max(1_000),
  correct: z.int().min(0).max(1_000),
});
export type QuestionStatsDelta = z.output<typeof questionStatsDeltaSchema>;

/** Blockgröße für `$in` und Bulk-Writes. */
export const QUESTION_BATCH_SIZE = 500;

/** Bulk-Operationen für die Fragen-Statistik (auch in der Abschluss-Transaktion genutzt). */
export function questionStatsOperations(deltas: readonly QuestionStatsDelta[]): AnyBulkWriteOperation<QuestionDoc>[] {
  const merged = new Map<string, { shown: number; correct: number }>();
  for (const delta of deltas) {
    const parsed = questionStatsDeltaSchema.parse(delta);
    const entry = merged.get(parsed.questionId) ?? { shown: 0, correct: 0 };
    entry.shown += parsed.shown;
    entry.correct += parsed.correct;
    merged.set(parsed.questionId, entry);
  }
  return [...merged].map(([questionId, delta]) => ({
    updateOne: {
      filter: { _id: questionId },
      update: { $inc: { "stats.shown": delta.shown, "stats.correct": delta.correct } },
    },
  }));
}

export interface QuestionsRepo {
  /** Spielbarer Pool mit Projektion `{ _id, category, topic, difficulty }`. */
  loadPool(pool: QuestionPool): Promise<PoolEntry[]>;
  /** Voll-Dokumente (Spiel-Projektion) per `$in`; unbekannte IDs fehlen im Ergebnis. */
  findForPlay(questionIds: readonly string[]): Promise<PlayQuestion[]>;
  findById(questionId: string): Promise<QuestionDoc | null>;
  /** Geänderte Fragen seit `since` (Sicherheitsnetz-Reload, Index `updatedAt`). */
  findChangedSince(since: Date): Promise<QuestionChange[]>;
  /** `$inc` shown/correct per `bulkWrite` (`ordered: false`). */
  incrementStats(deltas: readonly QuestionStatsDelta[], session?: ClientSession): Promise<number>;
  /** Bewertungs-Zähler anpassen (Delta −1…+1 je Feld). */
  adjustRatingCounts(questionId: string, delta: { likes: number; dislikes: number }): Promise<void>;
  incrementReports(questionId: string): Promise<void>;
  /** Schutzautomatik: sofort aus dem Pool; `false`, wenn bereits retired. */
  autoRetire(questionId: string, reason: "reports" | "rating", at: Date): Promise<boolean>;
}

const ratingDeltaSchema = z.int().min(-1).max(1);

export function createQuestionsRepo(questions: Collection<QuestionDoc>): QuestionsRepo {
  return {
    async loadPool(pool) {
      return questions
        .find<PoolEntry>({ status: { $in: playableStatuses(pool) } }, { projection: POOL_PROJECTION })
        .toArray();
    },

    async findForPlay(questionIds) {
      const ids = uniqueIds(questionIds.map((id) => questionIdSchema.parse(id)));
      const found: PlayQuestion[] = [];
      for (const part of chunk(ids, QUESTION_BATCH_SIZE)) {
        found.push(
          ...(await questions.find<PlayQuestion>({ _id: { $in: part } }, { projection: PLAY_PROJECTION }).toArray()),
        );
      }
      return found;
    },

    async findById(questionId) {
      return questions.findOne({ _id: questionIdSchema.parse(questionId) });
    },

    async findChangedSince(since) {
      return questions
        .find<QuestionChange>(
          { updatedAt: { $gt: since } },
          { projection: { ...POOL_PROJECTION, status: 1, updatedAt: 1 } },
        )
        .sort({ updatedAt: 1 })
        .toArray();
    },

    async incrementStats(deltas, session) {
      const operations = questionStatsOperations(deltas);
      let modified = 0;
      for (const part of chunk(operations, QUESTION_BATCH_SIZE)) {
        const result = await questions.bulkWrite(part, { ordered: false, session });
        modified += result.modifiedCount;
      }
      return modified;
    },

    async adjustRatingCounts(questionId, delta) {
      const likes = ratingDeltaSchema.parse(delta.likes);
      const dislikes = ratingDeltaSchema.parse(delta.dislikes);
      if (likes === 0 && dislikes === 0) return;
      await questions.updateOne(
        { _id: questionIdSchema.parse(questionId) },
        { $inc: { "stats.likes": likes, "stats.dislikes": dislikes } },
      );
    },

    async incrementReports(questionId) {
      await questions.updateOne({ _id: questionIdSchema.parse(questionId) }, { $inc: { "stats.reports": 1 } });
    },

    async autoRetire(questionId, reason, at) {
      const result = await questions.updateOne(
        { _id: questionIdSchema.parse(questionId), status: { $ne: "retired" } },
        {
          $set: {
            status: "retired",
            autoRetired: { reason: z.enum(["reports", "rating"]).parse(reason), at },
            updatedAt: at,
          },
        },
      );
      return result.modifiedCount === 1;
    },
  };
}
