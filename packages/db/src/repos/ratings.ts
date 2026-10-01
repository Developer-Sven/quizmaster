/**
 * questionRatings (docs/04, docs/08 §5): Daumen hoch/runter – eine Bewertung pro Gast und Frage
 * (`_id = questionId:guestId`, überschreibbar).
 *
 * `rate` ist atomar: Bewertung und Zähler `stats.likes/dislikes` der Frage ändern sich in EINER Transaktion
 * (`withTransaction`, wiederholt bei Schreibkonflikten). Vorher waren es zwei getrennte Writes – ein Abbruch
 * dazwischen oder zwei parallele Änderungen derselben Person (Zwischenstand < 0 scheitert am Validator
 * `minimum: 0`) ließen die Zähler driften. Der Stand der Frage nach der Änderung geht an die Schutzautomatik.
 *
 * Schutzautomatik (docs/08 §5): Bewertungsquote (Daumen hoch / alle) unter 30 % bei mindestens 20 Bewertungen
 * → Frage sofort aus dem Pool. Gezählt werden Bewertungen seit der letzten Inhalts-/Statusänderung der Frage
 * (`summary(questionId, since)`), damit eine geprüfte Frage nicht an Bewertungen ihrer alten Fassung scheitert.
 */
import { RATING_VALUES, type RatingValue } from "@quizmaster/shared";
import { ownerGuestIdSchema, type QuestionRatingDoc, questionRatingId, RETENTION } from "@quizmaster/shared/documents";
import type { Collection, Filter } from "mongodb";
import { z } from "zod";
import { HOT_PATH_TIMEOUT_MS, POOL_LOAD_TIMEOUT_MS } from "../client.ts";
import { chunk, questionIdSchema, uniqueIds } from "./ids.ts";
import {
  type QuestionQualityState,
  type QuestionsRepo,
  SCRIPT_READ_PREFERENCE,
  type ScriptReadOptions,
} from "./questions.ts";

const ratingValueSchema = z.literal(RATING_VALUES);

/** Schutzautomatik: Quote unter 30 % bei mindestens 20 Bewertungen (docs/08 §5). */
export const AUTO_RETIRE_RATING = Object.freeze({ minRatings: 20, belowPercent: 30 });
/** Prüf-Queue „schlecht bewertet“ (admin:reports): Quote unter 50 % ab 10 Bewertungen, noch nicht zurückgezogen. */
export const RATING_WATCH = Object.freeze({ minRatings: 10, belowPercent: 50 });

/** Gesamtfrist einer Bewertung inkl. Wiederholungen bei Schreibkonflikten (unter der 5-s-Frist der Apps). */
export const RATE_TRANSACTION_TIMEOUT_MS = HOT_PATH_TIMEOUT_MS;

/** Blockgröße für `$or`-Abfragen mehrerer Fragen. */
const SUMMARY_BATCH_SIZE = 200;

export interface RatingSummary {
  likes: number;
  dislikes: number;
}

export interface RatingRule {
  minRatings: number;
  /** Quote (likes / alle) in Prozent, unter der die Regel greift. */
  belowPercent: number;
}

/** Anzahl Bewertungen. */
export function ratingTotal(summary: RatingSummary): number {
  return summary.likes + summary.dislikes;
}

/** Bewertungsquote 0…1 (Anteil Daumen hoch) oder `null` ohne Bewertungen. */
export function ratingQuote(summary: RatingSummary): number | null {
  const total = ratingTotal(summary);
  return total === 0 ? null : summary.likes / total;
}

/** Greift die Regel? Ganzzahlig: likes / total < p % ⇔ 100 · likes < p · total. */
export function isRatingBelow(summary: RatingSummary, rule: RatingRule): boolean {
  const total = ratingTotal(summary);
  return total >= rule.minRatings && 100 * summary.likes < rule.belowPercent * total;
}

/** Schutzautomatik: Quote < 30 % bei ≥ 20 Bewertungen. */
export function isRatingRetireDue(summary: RatingSummary): boolean {
  return isRatingBelow(summary, AUTO_RETIRE_RATING);
}

export interface RatingChange {
  previous: RatingValue | null;
  current: RatingValue;
  /** Änderung der Frage-Zähler. */
  delta: { likes: number; dislikes: number };
  /** Stand der Frage nach der Änderung (aus derselben Transaktion); `null`, wenn es die Frage nicht gibt. */
  question: QuestionQualityState | null;
}

/** Zähler-Änderung von `previous` nach `current`. */
export function ratingDelta(previous: RatingValue | null, current: RatingValue): { likes: number; dislikes: number } {
  const count = (value: RatingValue | null) => ({ likes: value === 1 ? 1 : 0, dislikes: value === -1 ? 1 : 0 });
  const before = count(previous);
  const after = count(current);
  return { likes: after.likes - before.likes, dislikes: after.dislikes - before.dislikes };
}

export interface RatedQuestion extends RatingSummary {
  questionId: string;
}

export interface RatingsRepo {
  /** Bewertung setzen/überschreiben und die Zähler der Frage anpassen – atomar (Transaktion). */
  rate(questionId: string, guestId: string, value: RatingValue, now: Date): Promise<RatingChange>;
  /**
   * Likes/Dislikes einer Frage aus den Bewertungen (TTL 365 Tage); mit `since` nur Bewertungen, die seitdem
   * gesetzt oder geändert wurden (Schutzautomatik: seit der letzten Änderung der Frage).
   */
  summary(questionId: string, since?: Date): Promise<RatingSummary>;
  /** Wie `summary` für mehrere Fragen mit je eigenem `since` (Prüf-Queue); Fragen ohne Bewertung fehlen. */
  summaries(
    entries: readonly { questionId: string; since?: Date }[],
    options?: ScriptReadOptions,
  ): Promise<Map<string, RatingSummary>>;
  /** Fragen mit mindestens `minRatings` Bewertungen (Kandidaten für „schlecht bewertet“). */
  countsByQuestion(options: ScriptReadOptions & { minRatings: number }): Promise<RatedQuestion[]>;
  /** Eigene Bewertungen eines Gasts (`myRating` im Rückblick). */
  findByGuest(guestId: string, questionIds: readonly string[]): Promise<Map<string, RatingValue>>;
}

const minRatingsSchema = z.int().min(1).max(1_000_000);

/** Gruppiert Bewertungen nach Wert (gemeinsame `$group`-Stufe). */
const LIKES_DISLIKES_GROUP = {
  likes: { $sum: { $cond: [{ $eq: ["$value", 1] }, 1, 0] } },
  dislikes: { $sum: { $cond: [{ $eq: ["$value", -1] }, 1, 0] } },
} as const;

export function createRatingsRepo(ratings: Collection<QuestionRatingDoc>, questions: QuestionsRepo): RatingsRepo {
  const scriptRead = (options: ScriptReadOptions = {}) => ({
    readPreference: options.readPreference ?? SCRIPT_READ_PREFERENCE,
    timeoutMS: POOL_LOAD_TIMEOUT_MS,
  });

  return {
    async rate(questionId, guestId, value, now) {
      const question = questionIdSchema.parse(questionId);
      const guest = ownerGuestIdSchema.parse(guestId);
      const current = ratingValueSchema.parse(value);
      const ratingId = questionRatingId(question, guest);
      const expiresAt = new Date(now.getTime() + RETENTION.questionRatingMs);
      // Derselbe Client wie für `questions` (beide aus `createRepositories`). `withTransaction` wiederholt den
      // Callback bei Schreibkonflikten – jeder Versuch liest den vorherigen Wert in seiner Transaktion neu.
      return ratings.db.client.withSession((session) =>
        session.withTransaction(
          async (): Promise<RatingChange> => {
            const before = await ratings.findOneAndUpdate(
              { _id: ratingId },
              { $set: { questionId: question, value: current, updatedAt: now, expiresAt } },
              { upsert: true, returnDocument: "before", projection: { value: 1 }, session },
            );
            const previous = before === null ? null : before.value;
            const delta = ratingDelta(previous, current);
            const state = await questions.adjustRatingCounts(question, delta, session);
            return { previous, current, delta, question: state };
          },
          { timeoutMS: RATE_TRANSACTION_TIMEOUT_MS },
        ),
      );
    },

    async summary(questionId, since) {
      const match: Filter<QuestionRatingDoc> = { questionId: questionIdSchema.parse(questionId) };
      if (since !== undefined) match.updatedAt = { $gte: z.date().parse(since) };
      const [row] = await ratings
        .aggregate<RatingSummary>(
          [{ $match: match }, { $group: { _id: null, ...LIKES_DISLIKES_GROUP } }, { $project: { _id: 0 } }],
          { timeoutMS: HOT_PATH_TIMEOUT_MS },
        )
        .toArray();
      return { likes: row?.likes ?? 0, dislikes: row?.dislikes ?? 0 };
    },

    async summaries(entries, options) {
      const sinceById = new Map<string, Date | undefined>();
      for (const entry of entries) {
        sinceById.set(questionIdSchema.parse(entry.questionId), entry.since && z.date().parse(entry.since));
      }
      const result = new Map<string, RatingSummary>();
      for (const part of chunk(uniqueIds([...sinceById.keys()]), SUMMARY_BATCH_SIZE)) {
        // Je Frage ein `$or`-Zweig – jeder nutzt den Index `questionId` (Planstufe OR → IXSCAN).
        const branches: Filter<QuestionRatingDoc>[] = part.map((questionId) => {
          const since = sinceById.get(questionId);
          return since === undefined ? { questionId } : { questionId, updatedAt: { $gte: since } };
        });
        const rows = await ratings
          .aggregate<RatedQuestion>(
            [
              { $match: { $or: branches } },
              { $group: { _id: "$questionId", ...LIKES_DISLIKES_GROUP } },
              { $project: { _id: 0, questionId: "$_id", likes: 1, dislikes: 1 } },
            ],
            scriptRead(options),
          )
          .toArray();
        for (const row of rows) result.set(row.questionId, { likes: row.likes, dislikes: row.dislikes });
      }
      return result;
    },

    async countsByQuestion(options) {
      const minRatings = minRatingsSchema.parse(options.minRatings);
      // `$sort` auf questionId zuerst: Der Index `questionId` liefert die Reihenfolge (IXSCAN statt COLLSCAN).
      return ratings
        .aggregate<RatedQuestion>(
          [
            { $sort: { questionId: 1 } },
            { $group: { _id: "$questionId", ...LIKES_DISLIKES_GROUP } },
            { $match: { $expr: { $gte: [{ $add: ["$likes", "$dislikes"] }, minRatings] } } },
            { $project: { _id: 0, questionId: "$_id", likes: 1, dislikes: 1 } },
          ],
          { ...scriptRead(options), allowDiskUse: true },
        )
        .toArray();
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
