/**
 * questions (docs/04 §Fragenauswahl): Pool laden mit schmaler Projektion (Index
 * `status + category + difficulty`, CSOT-Frist `POOL_LOAD_TIMEOUT_MS`), Voll-Dokumente der gezogenen Fragen per
 * `$in` (Hot Path, `HOT_PATH_TIMEOUT_MS`), inkrementeller
 * Reload über `updatedAt`, Statistik per `bulkWrite` (`ordered: false`) und die Fragenqualität im Betrieb
 * (docs/08 §5):
 *
 * - Schutzautomatik: `autoRetire` nimmt eine Frage sofort aus dem Pool (`retired` + `autoRetired`) – nur, solange
 *   sie seit der Prüfung unverändert ist (Guard auf `updatedAt`), damit ein paralleler Seed oder eine
 *   Wiederherstellung nie überschrieben wird. `restoreAutoRetired` macht das rückgängig (admin:reports).
 *   Missbrauchsbremse: `countAutoRetiredSince` zählt die automatischen Rückzüge im Fenster (`AUTO_RETIRE_BUDGET`).
 * - Live-Zähler: `countPlayable(category)` zählt spielbare/belegte Fragen einer Kategorie (Index
 *   `status_category_difficulty`, ohne Dokumentzugriff).
 * - Kalibrierung: Trefferquote je Frage ab 30 Anzeigen → Vorschlag neue Schwierigkeit (`difficultyForHitRate`),
 *   unter 10 % → Prüf-Queue (`needsHitRateReview`).
 */

import { categoryIdSchema, type Difficulty } from "@quizmaster/shared";
import type { QuestionDbStatus } from "@quizmaster/shared/content";
import type { QuestionDoc } from "@quizmaster/shared/documents";
import type { AnyBulkWriteOperation, ClientSession, Collection, Document, Filter, ReadPreferenceLike } from "mongodb";
import { z } from "zod";
import { HOT_PATH_TIMEOUT_MS, POOL_LOAD_TIMEOUT_MS } from "../client.ts";
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

/**
 * Stand einer Frage für die Schutzautomatik: Status, Kategorie (Live-Zähler), Statistik und `updatedAt` – die
 * letzte Inhalts- oder Statusänderung (Seed, Schutzautomatik, Wiederherstellung). Meldungen und Bewertungen
 * zählen erst ab diesem Zeitpunkt: Nach einer Prüfung zieht Feedback zur alten Fassung die Frage nicht erneut.
 */
export type QuestionQualityState = Pick<
  QuestionDoc,
  "_id" | "category" | "status" | "autoRetired" | "updatedAt" | "stats"
>;
export const QUALITY_PROJECTION = { _id: 1, category: 1, status: 1, autoRetired: 1, updatedAt: 1, stats: 1 } as const;

/** Anzeige einer Frage in der Prüf-Queue (`admin:reports`) – ohne Antworten und Hash. */
export type ReviewQuestion = Pick<
  QuestionDoc,
  "_id" | "category" | "topic" | "difficulty" | "prompt" | "status" | "autoRetired" | "updatedAt" | "stats"
>;
export const REVIEW_PROJECTION = {
  _id: 1,
  category: 1,
  topic: 1,
  difficulty: 1,
  prompt: 1,
  status: 1,
  autoRetired: 1,
  updatedAt: 1,
  stats: 1,
} as const;

/** Statistik je Frage für `content:calibrate` (mit `contentHash`, damit nur die gespielte Fassung angepasst wird). */
export type CalibrationRow = Pick<
  QuestionDoc,
  "_id" | "category" | "topic" | "difficulty" | "status" | "contentHash"
> & {
  stats: Pick<QuestionDoc["stats"], "shown" | "correct">;
};
export const CALIBRATION_PROJECTION = {
  _id: 1,
  category: 1,
  topic: 1,
  difficulty: 1,
  status: 1,
  contentHash: 1,
  "stats.shown": 1,
  "stats.correct": 1,
} as const;

/** Gründe der Schutzautomatik (docs/04 `autoRetired.reason`). */
export const AUTO_RETIRE_REASONS = ["reports", "rating"] as const;
export type AutoRetireReason = (typeof AUTO_RETIRE_REASONS)[number];
const autoRetireReasonSchema = z.enum(AUTO_RETIRE_REASONS);

/** Lesezugriffe der Skripte (Statistik, Prüf-Queue) entlasten den Primary (docs/07 §MongoDB). */
export const SCRIPT_READ_PREFERENCE = "secondaryPreferred" as const;

/** Optionen für Lesezugriffe der Skripte. */
export interface ScriptReadOptions {
  /** Standard `secondaryPreferred` (docs/07). */
  readPreference?: ReadPreferenceLike;
}

/** Spielbare (`unverified` + `approved`) und belegte (`approved`) Fragen einer Kategorie. */
export interface PlayableCounts {
  playableCount: number;
  approvedCount: number;
}

export const questionStatsDeltaSchema = z.strictObject({
  questionId: questionIdSchema,
  shown: z.int().min(0).max(1_000),
  correct: z.int().min(0).max(1_000),
});
export type QuestionStatsDelta = z.output<typeof questionStatsDeltaSchema>;

/** Blockgröße für `$in` und Bulk-Writes. */
export const QUESTION_BATCH_SIZE = 500;

/** Höchstzahl automatisch zurückgezogener Fragen je Abfrage der Prüf-Queue. */
export const AUTO_RETIRED_LIST_MAX = 2_000;

/**
 * Missbrauchsbremse der Schutzautomatik: höchstens so viele automatische Rückzüge je Kategorie bzw. insgesamt im
 * gleitenden Fenster. Darüber bleibt eine fällige Frage im Pool (Meldungen/Bewertungen bleiben in der Prüf-Queue),
 * Realtime zählt `qm_questions_auto_retire_suppressed_total`, der Watchdog alarmiert. Ohne Bremse könnten wenige
 * kostenlose Gast-Sessions Kategorien unter die Mindestmenge drücken; im Normalbetrieb liegt die Automatik weit
 * darunter (geprüfter Katalog, Rückzüge sind Einzelfälle).
 */
export const AUTO_RETIRE_BUDGET = Object.freeze({ windowMs: 24 * 60 * 60 * 1_000, perCategory: 5, total: 20 });

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

// --- Kalibrierung (docs/08 §5) ---------------------------------------------------------------------------------

/**
 * Kalibrierung: ab `minShown` Anzeigen gilt die Trefferquote als aussagekräftig; darunter `reviewBelowPercent`
 * kommt die Frage in die Prüf-Queue statt eine neue Schwierigkeit zu bekommen (vermutlich falsch oder irreführend).
 */
export const CALIBRATION = Object.freeze({ minShown: 30, reviewBelowPercent: 10 });

/**
 * Untergrenzen der Trefferquote je Schwierigkeit in Prozent (docs/08 §5: 1 > 85 %, 2 65–85 %, 3 45–65 %,
 * 4 25–45 %, 5 < 25 %). Grenzwerte gehören zur leichteren Stufe, außer 85 % (Stufe 1 verlangt „mehr als“):
 * 85 % → 2, 65 % → 2, 45 % → 3, 25 % → 4.
 */
export const HIT_RATE_BANDS = Object.freeze([
  { difficulty: 1, minPercent: 85, inclusive: false },
  { difficulty: 2, minPercent: 65, inclusive: true },
  { difficulty: 3, minPercent: 45, inclusive: true },
  { difficulty: 4, minPercent: 25, inclusive: true },
] as const);

const countSchema = z.int().min(0);

function checkedCounts(shown: number, correct: number): { shown: number; correct: number } {
  const parsedShown = countSchema.parse(shown);
  // Mehr richtige als gezeigte Antworten sind ein Datenfehler – dann zählt höchstens jede Anzeige.
  return { shown: parsedShown, correct: Math.min(countSchema.parse(correct), parsedShown) };
}

/** Trefferquote 0…1 (0 bei 0 Anzeigen). */
export function hitRate(shown: number, correct: number): number {
  const counts = checkedCounts(shown, correct);
  return counts.shown === 0 ? 0 : counts.correct / counts.shown;
}

/** Schwierigkeit zur Trefferquote (ganzzahlig verglichen, ohne Rundungsfehler an den Grenzen). */
export function difficultyForHitRate(shown: number, correct: number): Difficulty {
  const counts = checkedCounts(shown, correct);
  for (const band of HIT_RATE_BANDS) {
    const scaled = 100 * counts.correct;
    const limit = band.minPercent * counts.shown;
    if (band.inclusive ? scaled >= limit : scaled > limit) return band.difficulty;
  }
  return 5;
}

/** Trefferquote unter 10 % → Prüf-Queue (nur ab `minShown` Anzeigen aussagekräftig). */
export function needsHitRateReview(shown: number, correct: number, minShown: number = CALIBRATION.minShown): boolean {
  const counts = checkedCounts(shown, correct);
  return counts.shown >= minShown && 100 * counts.correct < CALIBRATION.reviewBelowPercent * counts.shown;
}

export interface CalibrationResult {
  questionId: string;
  category: string;
  topic: string;
  status: QuestionDbStatus;
  contentHash: string;
  shown: number;
  correct: number;
  /** Trefferquote 0…1. */
  rate: number;
  current: Difficulty;
  suggested: Difficulty;
  /** Trefferquote < 10 % → Prüf-Queue; die Schwierigkeit bleibt dann unverändert. */
  review: boolean;
  /** Vorschlag weicht ab und die Frage muss nicht geprüft werden. */
  change: boolean;
}

/** Vorschlag für eine Frage aus ihrer Statistik. */
export function calibrateQuestion(row: CalibrationRow, minShown: number = CALIBRATION.minShown): CalibrationResult {
  const { shown, correct } = checkedCounts(row.stats.shown, row.stats.correct);
  const suggested = difficultyForHitRate(shown, correct);
  const review = needsHitRateReview(shown, correct, minShown);
  return {
    questionId: row._id,
    category: row.category,
    topic: row.topic,
    status: row.status,
    contentHash: row.contentHash,
    shown,
    correct,
    rate: hitRate(shown, correct),
    current: row.difficulty,
    suggested,
    review,
    change: !review && suggested !== row.difficulty,
  };
}

// --- Repository ------------------------------------------------------------------------------------------------

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
  /**
   * Bewertungs-Zähler anpassen (Delta −1…+1 je Feld; nie unter 0). Mit `session` Teil der Transaktion von
   * `ratings.rate`. Liefert den Stand danach (`null`, wenn es die Frage nicht gibt).
   */
  adjustRatingCounts(
    questionId: string,
    delta: { likes: number; dislikes: number },
    session?: ClientSession,
  ): Promise<QuestionQualityState | null>;
  /** `stats.reports` + 1; liefert den Stand danach (`null`, wenn es die Frage nicht gibt). */
  incrementReports(questionId: string): Promise<QuestionQualityState | null>;
  /** Stand für die Schutzautomatik. */
  findQualityState(questionId: string): Promise<QuestionQualityState | null>;
  /**
   * Schutzautomatik: sofort aus dem Pool (`retired` + `autoRetired`). `false`, wenn bereits retired oder – mit
   * `guard` – seit der Prüfung geändert (z. B. paralleler Seed oder Wiederherstellung).
   */
  autoRetire(questionId: string, reason: AutoRetireReason, at: Date, guard?: { updatedAt: Date }): Promise<boolean>;
  /**
   * Wiederherstellung nach Prüfung (admin:reports --restore): `autoRetired` entfernen und den Status aus dem
   * Repo setzen – nur, wenn die Frage automatisch zurückgezogen ist und ihr Inhalt noch `contentHash` entspricht.
   */
  restoreAutoRetired(
    questionId: string,
    target: { status: "unverified" | "approved"; contentHash: string },
    at: Date,
  ): Promise<boolean>;
  /** Spielbare und belegte Fragen einer Kategorie (Live-Zähler). */
  countPlayable(category: string): Promise<PlayableCounts>;
  /** Fragen für die Prüf-Queue per `$in` (unbekannte IDs fehlen). */
  findForReview(questionIds: readonly string[], options?: ScriptReadOptions): Promise<ReviewQuestion[]>;
  /**
   * Automatisch zurückgezogene Fragen, neueste zuerst (höchstens `limit` bzw. `AUTO_RETIRED_LIST_MAX`); optional nur
   * seit `since` bzw. aus einem Grund (Massen-Wiederherstellung, admin:reports --restore-auto).
   */
  listAutoRetired(
    options?: ScriptReadOptions & { since?: Date; reason?: AutoRetireReason; limit?: number },
  ): Promise<{ questions: ReviewQuestion[]; truncated: boolean }>;
  /** Automatische Rückzüge seit `since` (Missbrauchsbremse `AUTO_RETIRE_BUDGET`), optional nur einer Kategorie. */
  countAutoRetiredSince(since: Date, category?: string): Promise<number>;
  /** Spielbare Fragen mit mindestens `minShown` Anzeigen (Kalibrierung). */
  calibrationStats(options: ScriptReadOptions & { minShown: number }): Promise<CalibrationRow[]>;
}

const ratingDeltaSchema = z.int().min(-1).max(1);
const contentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const restoreStatusSchema = z.enum(["unverified", "approved"]);
const minShownSchema = z.int().min(1).max(1_000_000_000);

const HOT_PATH = { timeoutMS: HOT_PATH_TIMEOUT_MS } as const;

export function createQuestionsRepo(questions: Collection<QuestionDoc>): QuestionsRepo {
  /** Lesen für Skripte: Standard `secondaryPreferred`, Frist wie beim Laden des ganzen Pools. */
  const scriptRead = (options: ScriptReadOptions = {}) => ({
    readPreference: options.readPreference ?? SCRIPT_READ_PREFERENCE,
    timeoutMS: POOL_LOAD_TIMEOUT_MS,
  });

  return {
    async loadPool(pool) {
      return questions
        .find<PoolEntry>(
          { status: { $in: playableStatuses(pool) } },
          { projection: POOL_PROJECTION, timeoutMS: POOL_LOAD_TIMEOUT_MS },
        )
        .toArray();
    },

    async findForPlay(questionIds) {
      const ids = uniqueIds(questionIds.map((id) => questionIdSchema.parse(id)));
      const found: PlayQuestion[] = [];
      for (const part of chunk(ids, QUESTION_BATCH_SIZE)) {
        found.push(
          ...(await questions
            .find<PlayQuestion>({ _id: { $in: part } }, { projection: PLAY_PROJECTION, timeoutMS: HOT_PATH_TIMEOUT_MS })
            .toArray()),
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

    async adjustRatingCounts(questionId, delta, session) {
      const id = questionIdSchema.parse(questionId);
      const likes = ratingDeltaSchema.parse(delta.likes);
      const dislikes = ratingDeltaSchema.parse(delta.dislikes);
      // In einer Transaktion keine eigene Frist (die Transaktion hat eine Gesamtfrist).
      const options = session === undefined ? HOT_PATH : { session };
      if (likes === 0 && dislikes === 0) {
        return questions.findOne<QuestionQualityState>({ _id: id }, { ...options, projection: QUALITY_PROJECTION });
      }
      // Update-Pipeline mit Untergrenze 0: Ein älterer Zählerfehler darf eine Bewertung nie am Validator
      // (`minimum: 0`) scheitern lassen; neue Abweichungen verhindert die Transaktion in `ratings.rate`.
      return questions.findOneAndUpdate(
        { _id: id },
        [
          {
            $set: {
              "stats.likes": { $max: [0, { $add: [{ $ifNull: ["$stats.likes", 0] }, likes] }] },
              "stats.dislikes": { $max: [0, { $add: [{ $ifNull: ["$stats.dislikes", 0] }, dislikes] }] },
            },
          },
        ],
        { ...options, returnDocument: "after", projection: QUALITY_PROJECTION },
      );
    },

    async incrementReports(questionId) {
      return questions.findOneAndUpdate(
        { _id: questionIdSchema.parse(questionId) },
        { $inc: { "stats.reports": 1 } },
        { ...HOT_PATH, returnDocument: "after", projection: QUALITY_PROJECTION },
      );
    },

    async findQualityState(questionId) {
      return questions.findOne<QuestionQualityState>(
        { _id: questionIdSchema.parse(questionId) },
        { ...HOT_PATH, projection: QUALITY_PROJECTION },
      );
    },

    async autoRetire(questionId, reason, at, guard) {
      const filter: Filter<QuestionDoc> = { _id: questionIdSchema.parse(questionId), status: { $ne: "retired" } };
      if (guard !== undefined) filter.updatedAt = z.date().parse(guard.updatedAt);
      const result = await questions.updateOne(
        filter,
        {
          $set: { status: "retired", autoRetired: { reason: autoRetireReasonSchema.parse(reason), at }, updatedAt: at },
        },
        HOT_PATH,
      );
      return result.modifiedCount === 1;
    },

    async restoreAutoRetired(questionId, target, at) {
      const result = await questions.updateOne(
        {
          _id: questionIdSchema.parse(questionId),
          status: "retired",
          autoRetired: { $ne: null },
          contentHash: contentHashSchema.parse(target.contentHash),
        },
        { $set: { status: restoreStatusSchema.parse(target.status), autoRetired: null, updatedAt: at } },
      );
      return result.modifiedCount === 1;
    },

    async countPlayable(category) {
      const rows = await questions
        .aggregate<{ _id: QuestionDbStatus; count: number }>(
          [
            { $match: { status: { $in: playableStatuses("all") }, category: categoryIdSchema.parse(category) } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
          ],
          HOT_PATH,
        )
        .toArray();
      const count = (status: QuestionDbStatus) => rows.find((row) => row._id === status)?.count ?? 0;
      const approvedCount = count("approved");
      return { playableCount: count("unverified") + approvedCount, approvedCount };
    },

    async findForReview(questionIds, options) {
      const ids = uniqueIds(questionIds.map((id) => questionIdSchema.parse(id)));
      const found: ReviewQuestion[] = [];
      for (const part of chunk(ids, QUESTION_BATCH_SIZE)) {
        found.push(
          ...(await questions
            .find<ReviewQuestion>({ _id: { $in: part } }, { projection: REVIEW_PROJECTION, ...scriptRead(options) })
            .toArray()),
        );
      }
      return found;
    },

    async listAutoRetired(options = {}) {
      const limit = z
        .int()
        .min(1)
        .max(AUTO_RETIRED_LIST_MAX)
        .parse(options.limit ?? AUTO_RETIRED_LIST_MAX);
      const filter: Document = { status: "retired", autoRetired: { $ne: null } };
      if (options.since !== undefined) filter["autoRetired.at"] = { $gte: z.date().parse(options.since) };
      if (options.reason !== undefined) filter["autoRetired.reason"] = autoRetireReasonSchema.parse(options.reason);
      // Index status_category_difficulty (Präfix status = retired). Sortiert wird auf dem Server VOR der Höchstzahl –
      // nach einem Massenabzug zeigt die Queue so die neuesten statt einer beliebigen Teilmenge.
      const rows = await questions
        .find<ReviewQuestion>(filter as Filter<QuestionDoc>, { projection: REVIEW_PROJECTION, ...scriptRead(options) })
        .sort({ "autoRetired.at": -1, _id: 1 })
        .limit(limit + 1)
        .toArray();
      return { questions: rows.slice(0, limit), truncated: rows.length > limit };
    },

    async countAutoRetiredSince(since, category) {
      const filter: Document = { status: "retired", "autoRetired.at": { $gte: z.date().parse(since) } };
      if (category !== undefined) filter.category = categoryIdSchema.parse(category);
      // Index status_category_difficulty (status + category); zurückgezogene Fragen sind wenige.
      return questions.countDocuments(filter as Filter<QuestionDoc>, HOT_PATH);
    },

    async calibrationStats(options) {
      const minShown = minShownSchema.parse(options.minShown);
      return questions
        .find<CalibrationRow>(
          { status: { $in: playableStatuses("all") }, "stats.shown": { $gte: minShown } },
          { projection: CALIBRATION_PROJECTION, ...scriptRead(options) },
        )
        .toArray();
    },
  };
}
