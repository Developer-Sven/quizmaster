/**
 * questionReports (docs/04, docs/08 §5): Meldungen aus „Fragen ansehen“ (TTL 365 Tage), Prüf-Queue
 * (Index `status + createdAt`) und Zählung für die Schutzautomatik – verschiedene Gäste je Frage in
 * einem Zeitfenster (Index `questionId + createdAt`).
 *
 * Schutzautomatik: mindestens 3 OFFENE Meldungen „falsch/veraltet/mehrdeutig“ von verschiedenen Gästen in 7 Tagen.
 * Das Fenster beginnt frühestens bei der letzten Inhalts-/Statusänderung der Frage (`reportWindowStart`), und
 * erledigte (`resolved`) oder verworfene (`dismissed`) Meldungen zählen nicht – sonst zöge die nächste Meldung
 * eine geprüfte Frage sofort wieder zurück.
 *
 * Prüf-Queue (`buildReviewQueue`, Grundlage von `pnpm admin:reports` und `/faktencheck`): offene Meldungen je
 * Frage, automatisch zurückgezogene Fragen, schlecht bewertete Fragen und Fragen mit Trefferquote < 10 %. Die
 * guestIds verlassen die Datenbank dabei nie – gezählt wird serverseitig (`$addToSet` + `$size`).
 */
import { randomUUID } from "node:crypto";
import { lobbyCodeSchema, REPORT_REASONS, type ReportReason } from "@quizmaster/shared";
import type { QuestionDbStatus } from "@quizmaster/shared/content";
import {
  documentIdSchema,
  ownerGuestIdSchema,
  type QuestionReportDoc,
  REPORT_STATUSES,
  RETENTION,
  type ReportStatus,
} from "@quizmaster/shared/documents";
import type { Collection, Filter } from "mongodb";
import { z } from "zod";
import { HOT_PATH_TIMEOUT_MS, POOL_LOAD_TIMEOUT_MS } from "../client.ts";
import { chunk, questionIdSchema, uniqueIds } from "./ids.ts";
import {
  type AutoRetireReason,
  CALIBRATION,
  calibrateQuestion,
  type QuestionsRepo,
  type ReviewQuestion,
  SCRIPT_READ_PREFERENCE,
  type ScriptReadOptions,
} from "./questions.ts";
import { isRatingBelow, RATING_WATCH, type RatingSummary, type RatingsRepo, ratingQuote } from "./ratings.ts";

/** Gründe, die für die Schutzautomatik zählen (docs/08 §5). */
export const AUTO_RETIRE_REPORT_REASONS: readonly ReportReason[] = Object.freeze(["falsch", "veraltet", "mehrdeutig"]);

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Schutzautomatik: ≥ 3 Meldungen der Gründe oben von verschiedenen Gästen in 7 Tagen (docs/08 §5). */
export const AUTO_RETIRE_REPORTS = Object.freeze({
  minReporters: 3,
  windowMs: 7 * DAY_MS,
  reasons: AUTO_RETIRE_REPORT_REASONS,
});

/**
 * Beginn des Zählfensters: 7 Tage vor `now`, frühestens `baseline` (letzte Inhalts-/Statusänderung der Frage –
 * Meldungen zu einer schon geprüften Fassung zählen nicht erneut).
 */
export function reportWindowStart(now: Date, baseline: Date | null): Date {
  const windowStart = now.getTime() - AUTO_RETIRE_REPORTS.windowMs;
  return new Date(baseline === null ? windowStart : Math.max(windowStart, baseline.getTime()));
}

/** Schutzautomatik: genug verschiedene Gäste? */
export function isReportRetireDue(reporters: number): boolean {
  return reporters >= AUTO_RETIRE_REPORTS.minReporters;
}

export const newReportSchema = z.strictObject({
  questionId: questionIdSchema,
  reason: z.enum(REPORT_REASONS),
  guestId: ownerGuestIdSchema,
  lobbyCode: lobbyCodeSchema.nullable(),
});
export type NewReport = z.output<typeof newReportSchema>;

/** Schlüssel des Index `questionId_createdAt` (docs/04) – Meldungen einer Frage. */
const QUESTION_REPORTS_INDEX = { questionId: 1, createdAt: -1 } as const;

/** Höchstzahl je Queue-Abfrage. */
export const REPORT_QUEUE_MAX = 200;
/** Höchstzahl Fragen mit offenen Meldungen je Prüf-Queue (admin:reports). */
export const REVIEW_QUEUE_MAX = 1_000;

/** Abschluss offener Meldungen (admin:reports --resolve / --dismiss). */
export type ReportResolution = Extract<ReportStatus, "resolved" | "dismissed">;
const resolutionSchema = z.enum(["resolved", "dismissed"]);

/** Offene Meldungen einer Frage – ohne guestIds und Lobby-Codes. */
export interface OpenReportGroup {
  questionId: string;
  /** Anzahl offener Meldungen. */
  open: number;
  /** Verschiedene meldende Gäste (nur die Zahl). */
  reporters: number;
  /** Verschiedene Gäste mit Gründen der Schutzautomatik (falsch, veraltet, mehrdeutig). */
  severeReporters: number;
  byReason: Partial<Record<ReportReason, number>>;
  firstAt: Date;
  lastAt: Date;
  /** IDs der offenen Meldungen (für --resolve/--dismiss einzelner Meldungen). */
  reportIds: string[];
}

export interface ReportsRepo {
  create(report: NewReport, now: Date): Promise<QuestionReportDoc>;
  /** Offene Meldungen, neueste zuerst (Prüf-Queue). */
  listOpen(limit?: number): Promise<QuestionReportDoc[]>;
  setStatus(reportId: string, status: ReportStatus): Promise<boolean>;
  /**
   * Anzahl verschiedener Gäste mit OFFENEN Meldungen der Gründe `reasons` seit `since` (Schutzautomatik;
   * erledigte und verworfene Meldungen zählen nicht).
   */
  countDistinctReporters(questionId: string, since: Date, reasons?: readonly ReportReason[]): Promise<number>;
  /** Welche der Fragen hat dieser Gast bereits gemeldet? (`myReported` im Rückblick) */
  findReportedQuestionIds(guestId: string, questionIds: readonly string[]): Promise<Set<string>>;
  /** Offene Meldungen gruppiert je Frage, meiste zuerst (höchstens `limit` Fragen). */
  summarizeOpen(
    options?: ScriptReadOptions & { limit?: number },
  ): Promise<{ groups: OpenReportGroup[]; truncated: boolean }>;
  /** Alle Fragen mit mindestens einer offenen Meldung (ohne Höchstzahl; Kalibrierung lässt sie aus). */
  openQuestionIds(options?: ScriptReadOptions): Promise<Set<string>>;
  /** Offene Meldungen abschließen: eine Meldung (`reportId`) oder alle einer Frage (`questionId`); liefert die Anzahl. */
  resolveOpen(target: { reportId: string } | { questionId: string }, status: ReportResolution): Promise<number>;
}

export function createReportsRepo(reports: Collection<QuestionReportDoc>): ReportsRepo {
  return {
    async create(report, now) {
      const parsed = newReportSchema.parse(report);
      const doc: QuestionReportDoc = {
        _id: randomUUID(),
        ...parsed,
        status: "open",
        createdAt: now,
        expiresAt: new Date(now.getTime() + RETENTION.questionReportMs),
      };
      await reports.insertOne(doc);
      return doc;
    },

    async listOpen(limit = 50) {
      const capped = Math.max(1, Math.min(REPORT_QUEUE_MAX, Math.trunc(limit)));
      return reports.find({ status: "open" }).sort({ createdAt: -1 }).limit(capped).toArray();
    },

    async setStatus(reportId, status) {
      const result = await reports.updateOne(
        { _id: documentIdSchema.parse(reportId) },
        { $set: { status: z.enum(REPORT_STATUSES).parse(status) } },
      );
      return result.matchedCount === 1;
    },

    async countDistinctReporters(questionId, since, reasons = AUTO_RETIRE_REPORT_REASONS) {
      const reasonList = z.array(z.enum(REPORT_REASONS)).parse(reasons);
      const [row] = await reports
        .aggregate<{ reporters: number }>(
          [
            {
              $match: {
                questionId: questionIdSchema.parse(questionId),
                createdAt: { $gte: z.date().parse(since) },
                reason: { $in: reasonList },
                status: "open",
              },
            },
            { $group: { _id: "$guestId" } },
            { $count: "reporters" },
          ],
          // Selektiver Index je Frage – nie `status_createdAt` (alle offenen Meldungen aller Fragen).
          { timeoutMS: HOT_PATH_TIMEOUT_MS, hint: QUESTION_REPORTS_INDEX },
        )
        .toArray();
      return row?.reporters ?? 0;
    },

    async findReportedQuestionIds(guestId, questionIds) {
      const guest = ownerGuestIdSchema.parse(guestId);
      const ids = uniqueIds(questionIds.map((id) => questionIdSchema.parse(id)));
      const reported = new Set<string>();
      for (const part of chunk(ids, 500)) {
        const rows = await reports
          .find<Pick<QuestionReportDoc, "questionId">>(
            { questionId: { $in: part }, guestId: guest },
            { projection: { _id: 0, questionId: 1 } },
          )
          .toArray();
        for (const row of rows) reported.add(row.questionId);
      }
      return reported;
    },

    async summarizeOpen(options = {}) {
      const limit = z
        .int()
        .min(1)
        .max(REVIEW_QUEUE_MAX)
        .parse(options.limit ?? REVIEW_QUEUE_MAX);
      const rows = await reports
        .aggregate<Omit<OpenReportGroup, "byReason"> & { reasons: ReportReason[] }>(
          [
            { $match: { status: "open" } },
            {
              $group: {
                _id: "$questionId",
                open: { $sum: 1 },
                guests: { $addToSet: "$guestId" },
                severeGuests: {
                  $addToSet: { $cond: [{ $in: ["$reason", [...AUTO_RETIRE_REPORT_REASONS]] }, "$guestId", null] },
                },
                reasons: { $push: "$reason" },
                firstAt: { $min: "$createdAt" },
                lastAt: { $max: "$createdAt" },
                reportIds: { $push: "$_id" },
              },
            },
            // guestIds nur zählen – sie verlassen den Server nie (docs/06 Invariante 4).
            {
              $project: {
                _id: 0,
                questionId: "$_id",
                open: 1,
                reporters: { $size: "$guests" },
                severeReporters: { $size: { $setDifference: ["$severeGuests", [null]] } },
                reasons: 1,
                firstAt: 1,
                lastAt: 1,
                reportIds: 1,
              },
            },
            { $sort: { severeReporters: -1, open: -1, lastAt: -1, questionId: 1 } },
            { $limit: limit + 1 },
          ],
          {
            readPreference: options.readPreference ?? SCRIPT_READ_PREFERENCE,
            timeoutMS: POOL_LOAD_TIMEOUT_MS,
            allowDiskUse: true,
          },
        )
        .toArray();
      const groups = rows.slice(0, limit).map(({ reasons, ...group }) => {
        const byReason: Partial<Record<ReportReason, number>> = {};
        for (const reason of reasons) byReason[reason] = (byReason[reason] ?? 0) + 1;
        return { ...group, byReason, reportIds: [...group.reportIds].sort() };
      });
      return { groups, truncated: rows.length > limit };
    },

    async openQuestionIds(options = {}) {
      const rows = await reports
        .aggregate<{ _id: string }>([{ $match: { status: "open" } }, { $group: { _id: "$questionId" } }], {
          readPreference: options.readPreference ?? SCRIPT_READ_PREFERENCE,
          timeoutMS: POOL_LOAD_TIMEOUT_MS,
        })
        .toArray();
      return new Set(rows.map((row) => row._id));
    },

    async resolveOpen(target, status) {
      const filter: Filter<QuestionReportDoc> =
        "reportId" in target
          ? { _id: documentIdSchema.parse(target.reportId), status: "open" }
          : { questionId: questionIdSchema.parse(target.questionId), status: "open" };
      const result = await reports.updateMany(
        filter,
        { $set: { status: resolutionSchema.parse(status) } },
        "reportId" in target ? {} : { hint: QUESTION_REPORTS_INDEX },
      );
      return result.modifiedCount;
    },
  };
}

// --- Prüf-Queue (admin:reports, /faktencheck) ---------------------------------------------------------------------

/** Warum eine Frage in der Prüf-Queue steht. */
export const REVIEW_FLAGS = ["auto_retired", "reports", "low_rating", "low_hit_rate"] as const;
export type ReviewFlag = (typeof REVIEW_FLAGS)[number];

export interface ReviewQueueItem {
  questionId: string;
  /** Aus der Frage (fehlt die Frage in der DB, sind diese Felder `null`). */
  category: string | null;
  topic: string | null;
  difficulty: number | null;
  prompt: string | null;
  status: QuestionDbStatus | null;
  autoRetired: { reason: AutoRetireReason; at: Date } | null;
  /** Letzte Inhalts-/Statusänderung (Beginn der Zählfenster). */
  updatedAt: Date | null;
  flags: ReviewFlag[];
  /** Offene Meldungen (ohne guestIds). */
  reports: OpenReportGroup | null;
  /** Bewertungen seit `updatedAt` (nur bei `low_rating`). */
  ratingWindow: (RatingSummary & { quote: number | null; since: Date | null }) | null;
  /** Gesamtstatistik der Frage (alle Fassungen). */
  stats: { shown: number; correct: number; likes: number; dislikes: number; reports: number } | null;
  /** Trefferquote (nur bei `low_hit_rate`). */
  hitRate: { shown: number; correct: number; rate: number } | null;
  /** 0 = zuerst prüfen: zurückgezogen oder schwere Meldungen; 1 = nur leichte Meldungen; 2 = Bewertung; 3 = Trefferquote. */
  tier: 0 | 1 | 2 | 3;
}

export interface ReviewQueue {
  generatedAt: Date;
  /** Priorisiert: Stufe, dann Zahl der meldenden Gäste mit schweren Gründen, Meldungen, Aktualität. */
  items: ReviewQueueItem[];
  totals: {
    items: number;
    openReports: number;
    questionsWithReports: number;
    autoRetired: number;
    lowRating: number;
    lowHitRate: number;
  };
  /** Listen mit erreichter Höchstzahl (dann fehlen Einträge). */
  truncated: { reports: boolean; autoRetired: boolean };
  thresholds: {
    ratingWatch: { minRatings: number; belowPercent: number };
    calibration: { minShown: number; reviewBelowPercent: number };
  };
}

export interface ReviewQueueOptions extends ScriptReadOptions {
  now: Date;
  /** Höchstzahl Fragen mit offenen Meldungen (Standard `REVIEW_QUEUE_MAX`). */
  limit?: number;
  /** Mindestanzeigen für die Trefferquote (Standard 30). */
  minShown?: number;
}

function tierOf(item: Pick<ReviewQueueItem, "flags" | "reports">): ReviewQueueItem["tier"] {
  if (item.flags.includes("auto_retired") || (item.reports?.severeReporters ?? 0) > 0) return 0;
  if (item.flags.includes("reports")) return 1;
  if (item.flags.includes("low_rating")) return 2;
  return 3;
}

/** Sortierung der Prüf-Queue (deterministisch). */
export function compareReviewItems(a: ReviewQueueItem, b: ReviewQueueItem): number {
  const activity = (item: ReviewQueueItem) =>
    Math.max(item.reports?.lastAt.getTime() ?? 0, item.autoRetired?.at.getTime() ?? 0);
  return (
    a.tier - b.tier ||
    (b.reports?.severeReporters ?? 0) - (a.reports?.severeReporters ?? 0) ||
    Number(b.flags.includes("auto_retired")) - Number(a.flags.includes("auto_retired")) ||
    (b.reports?.open ?? 0) - (a.reports?.open ?? 0) ||
    (a.ratingWindow?.quote ?? 1) - (b.ratingWindow?.quote ?? 1) ||
    (a.hitRate?.rate ?? 1) - (b.hitRate?.rate ?? 1) ||
    activity(b) - activity(a) ||
    a.questionId.localeCompare(b.questionId)
  );
}

/**
 * Baut die Prüf-Queue (docs/08 §5, §8 `admin:reports`): alle Lesezugriffe mit `secondaryPreferred`, jede Abfrage
 * über einen Index (offene Meldungen: `status_createdAt`; zurückgezogene Fragen und Trefferquote:
 * `status_category_difficulty`; Bewertungen: `questionId`; Fragen: `_id`).
 */
export async function buildReviewQueue(
  repos: { questions: QuestionsRepo; reports: ReportsRepo; ratings: RatingsRepo },
  options: ReviewQueueOptions,
): Promise<ReviewQueue> {
  const read: ScriptReadOptions = { readPreference: options.readPreference ?? SCRIPT_READ_PREFERENCE };
  const minShown = options.minShown ?? CALIBRATION.minShown;
  const [open, retired, rated, calibration] = await Promise.all([
    repos.reports.summarizeOpen({ ...read, ...(options.limit === undefined ? {} : { limit: options.limit }) }),
    repos.questions.listAutoRetired(read),
    repos.ratings.countsByQuestion({ ...read, minRatings: RATING_WATCH.minRatings }),
    repos.questions.calibrationStats({ ...read, minShown }),
  ]);

  const lowHitRates = calibration.map((row) => calibrateQuestion(row, minShown)).filter((result) => result.review);
  const questions = new Map<string, ReviewQuestion>(retired.questions.map((question) => [question._id, question]));
  const missing = uniqueIds([
    ...open.groups.map((group) => group.questionId),
    ...rated.map((row) => row.questionId),
    ...lowHitRates.map((result) => result.questionId),
  ]).filter((id) => !questions.has(id));
  for (const question of await repos.questions.findForReview(missing, read)) questions.set(question._id, question);

  // Schlecht bewertet: nur Fragen im Spiel, gezählt seit ihrer letzten Änderung (wie die Schutzautomatik).
  const watchCandidates = rated.filter((row) => {
    const question = questions.get(row.questionId);
    return question !== undefined && question.status !== "retired";
  });
  const windows = await repos.ratings.summaries(
    watchCandidates.map((row) => ({ questionId: row.questionId, since: questions.get(row.questionId)?.updatedAt })),
    read,
  );

  const items = new Map<string, ReviewQueueItem>();
  const itemFor = (questionId: string): ReviewQueueItem => {
    let item = items.get(questionId);
    if (item === undefined) {
      const question = questions.get(questionId);
      item = {
        questionId,
        category: question?.category ?? null,
        topic: question?.topic ?? null,
        difficulty: question?.difficulty ?? null,
        prompt: question?.prompt ?? null,
        status: question?.status ?? null,
        autoRetired: question?.autoRetired ?? null,
        updatedAt: question?.updatedAt ?? null,
        flags: [],
        reports: null,
        ratingWindow: null,
        stats:
          question === undefined
            ? null
            : {
                shown: question.stats.shown,
                correct: question.stats.correct,
                likes: question.stats.likes,
                dislikes: question.stats.dislikes,
                reports: question.stats.reports,
              },
        hitRate: null,
        tier: 3,
      };
      items.set(questionId, item);
    }
    return item;
  };

  for (const question of retired.questions) itemFor(question._id).flags.push("auto_retired");
  for (const group of open.groups) {
    const item = itemFor(group.questionId);
    item.flags.push("reports");
    item.reports = group;
  }
  let lowRating = 0;
  for (const row of watchCandidates) {
    const window = windows.get(row.questionId) ?? { likes: 0, dislikes: 0 };
    if (!isRatingBelow(window, RATING_WATCH)) continue;
    lowRating += 1;
    const item = itemFor(row.questionId);
    item.flags.push("low_rating");
    item.ratingWindow = {
      ...window,
      quote: ratingQuote(window),
      since: questions.get(row.questionId)?.updatedAt ?? null,
    };
  }
  for (const result of lowHitRates) {
    const item = itemFor(result.questionId);
    item.flags.push("low_hit_rate");
    item.hitRate = { shown: result.shown, correct: result.correct, rate: result.rate };
  }

  const sorted = [...items.values()];
  for (const item of sorted) {
    item.flags.sort((a, b) => REVIEW_FLAGS.indexOf(a) - REVIEW_FLAGS.indexOf(b));
    item.tier = tierOf(item);
  }
  sorted.sort(compareReviewItems);
  return {
    generatedAt: options.now,
    items: sorted,
    totals: {
      items: sorted.length,
      openReports: open.groups.reduce((sum, group) => sum + group.open, 0),
      questionsWithReports: open.groups.length,
      autoRetired: retired.questions.length,
      lowRating,
      lowHitRate: lowHitRates.length,
    },
    truncated: { reports: open.truncated, autoRetired: retired.truncated },
    thresholds: {
      ratingWatch: { minRatings: RATING_WATCH.minRatings, belowPercent: RATING_WATCH.belowPercent },
      calibration: { minShown, reviewBelowPercent: CALIBRATION.reviewBelowPercent },
    },
  };
}
