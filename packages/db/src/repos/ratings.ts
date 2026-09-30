/**
 * questionRatings (docs/04, docs/08 §5): Daumen hoch/runter – eine Bewertung pro Gast und Frage
 * (`_id = questionId:guestId`, überschreibbar). Die Zähler `stats.likes/dislikes` der Frage werden
 * passend zur Änderung angepasst; die Quote für die Schutzautomatik liefert `summary()`.
 */
import { RATING_VALUES, type RatingValue } from "@quizmaster/shared";
import { ownerGuestIdSchema, type QuestionRatingDoc, questionRatingId, RETENTION } from "@quizmaster/shared/documents";
import type { Collection } from "mongodb";
import { z } from "zod";
import { chunk, questionIdSchema, uniqueIds } from "./ids.ts";
import type { QuestionsRepo } from "./questions.ts";

const ratingValueSchema = z.literal(RATING_VALUES);

export interface RatingChange {
  previous: RatingValue | null;
  current: RatingValue;
  /** Änderung der Frage-Zähler. */
  delta: { likes: number; dislikes: number };
}

/** Zähler-Änderung von `previous` nach `current`. */
export function ratingDelta(previous: RatingValue | null, current: RatingValue): { likes: number; dislikes: number } {
  const count = (value: RatingValue | null) => ({ likes: value === 1 ? 1 : 0, dislikes: value === -1 ? 1 : 0 });
  const before = count(previous);
  const after = count(current);
  return { likes: after.likes - before.likes, dislikes: after.dislikes - before.dislikes };
}

export interface RatingsRepo {
  /** Bewertung setzen/überschreiben und die Zähler der Frage anpassen. */
  rate(questionId: string, guestId: string, value: RatingValue, now: Date): Promise<RatingChange>;
  /** Likes/Dislikes einer Frage (Schutzautomatik: Quote < 30 % bei ≥ 20 Bewertungen). */
  summary(questionId: string): Promise<{ likes: number; dislikes: number }>;
  /** Eigene Bewertungen eines Gasts (`myRating` im Rückblick). */
  findByGuest(guestId: string, questionIds: readonly string[]): Promise<Map<string, RatingValue>>;
}

export function createRatingsRepo(ratings: Collection<QuestionRatingDoc>, questions: QuestionsRepo): RatingsRepo {
  return {
    async rate(questionId, guestId, value, now) {
      const question = questionIdSchema.parse(questionId);
      const guest = ownerGuestIdSchema.parse(guestId);
      const current = ratingValueSchema.parse(value);
      const before = await ratings.findOneAndUpdate(
        { _id: questionRatingId(question, guest) },
        {
          $set: {
            questionId: question,
            value: current,
            updatedAt: now,
            expiresAt: new Date(now.getTime() + RETENTION.questionRatingMs),
          },
        },
        { upsert: true, returnDocument: "before", projection: { value: 1 } },
      );
      const previous = before === null ? null : before.value;
      const delta = ratingDelta(previous, current);
      await questions.adjustRatingCounts(question, delta);
      return { previous, current, delta };
    },

    async summary(questionId) {
      const rows = await ratings
        .aggregate<{ _id: RatingValue; count: number }>([
          { $match: { questionId: questionIdSchema.parse(questionId) } },
          { $group: { _id: "$value", count: { $sum: 1 } } },
        ])
        .toArray();
      const count = (value: RatingValue) => rows.find((row) => row._id === value)?.count ?? 0;
      return { likes: count(1), dislikes: count(-1) };
    },

    async findByGuest(guestId, questionIds) {
      const guest = ownerGuestIdSchema.parse(guestId);
      const ids = uniqueIds(questionIds.map((id) => questionIdSchema.parse(id)));
      const result = new Map<string, RatingValue>();
      for (const part of chunk(ids, 500)) {
        const rows = await ratings
          .find<Pick<QuestionRatingDoc, "questionId" | "value">>(
            { _id: { $in: part.map((id) => questionRatingId(id, guest)) } },
            { projection: { _id: 0, questionId: 1, value: 1 } },
          )
          .toArray();
        for (const row of rows) result.set(row.questionId, row.value);
      }
      return result;
    },
  };
}
