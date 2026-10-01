/**
 * Bewertungen und Meldungen aus „Fragen ansehen“ (docs/01 §Spielende, docs/05 `game:review`,
 * `question:rate`, `question:report`; docs/08 §5 – hier nur die Speicherung, die Schutzautomatik folgt in W4).
 *
 * - `rate`: eine Bewertung je Gast und Frage, überschreibbar (`questionRatings._id = questionId:guestId`); die
 *   Zähler `stats.likes/dislikes` der Frage passt das Repository passend zur Änderung an.
 * - `report`: eine Meldung je Gast und Frage (weitere Meldungen derselben Person werden still ignoriert);
 *   `stats.reports` der Frage zählt mit.
 * - `reviewContext`: eigene Bewertungen/Meldungen für den Rückblick; bei DB-Problemen ohne diese Markierungen
 *   (der Rückblick selbst kommt aus dem Speicher und bleibt verfügbar).
 *
 * Alle Aufrufe sind befristet; Fragen-IDs sind hier immer DB-IDs (die Handler bilden Instanz-IDs vorher über
 * `findShownQuestion` ab – nur in diesem Spiel gezeigte Fragen).
 */
import type { RatingChange, Repositories } from "@quizmaster/db";
import type { ReviewContext } from "@quizmaster/game-engine";
import type { RatingValue, ReportReason } from "@quizmaster/shared";
import type { Logger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import { withTimeout } from "../registry/util.ts";

/** Frist je Datenbank-Aufruf. */
export const FEEDBACK_TIMEOUT_MS = 5_000;

export interface ReportInput {
  /** DB-ID der Frage. */
  questionId: string;
  guestId: string;
  reason: ReportReason;
  lobbyCode: string | null;
}

export type ReportResult = "created" | "duplicate";

export interface FeedbackService {
  /** Eigene Bewertungen und Meldungen zu den Fragen (DB-IDs); bei Fehlern leer. */
  reviewContext(guestId: string, questionIds: readonly string[]): Promise<ReviewContext>;
  rate(questionId: string, guestId: string, value: RatingValue): Promise<RatingChange>;
  report(input: ReportInput): Promise<ReportResult>;
}

export interface FeedbackServiceDeps {
  repos: Pick<Repositories, "ratings" | "reports" | "questions">;
  clock: { now(): number };
  logger: Logger;
  metrics: RealtimeMetrics;
  timeoutMs?: number;
}

export function createFeedbackService(deps: FeedbackServiceDeps): FeedbackService {
  const timeoutMs = deps.timeoutMs ?? FEEDBACK_TIMEOUT_MS;
  const log = deps.logger.child({ component: "feedback" });
  /** Laufende Meldungen je Gast und Frage (zwei schnelle Klicks ergeben nur eine Meldung). */
  const reporting = new Set<string>();

  const guarded = async <T>(operation: string, task: Promise<T>): Promise<T> => {
    try {
      return await withTimeout(task, timeoutMs, operation);
    } catch (error) {
      deps.metrics.recordMongoError(operation);
      throw error;
    }
  };

  return {
    async reviewContext(guestId, questionIds) {
      if (questionIds.length === 0) return { ratings: new Map(), reported: new Set() };
      try {
        const [ratings, reported] = await Promise.all([
          guarded("review_ratings", deps.repos.ratings.findByGuest(guestId, questionIds)),
          guarded("review_reports", deps.repos.reports.findReportedQuestionIds(guestId, questionIds)),
        ]);
        return { ratings, reported };
      } catch (error) {
        log.warn(
          { err: error, questions: questionIds.length },
          "Bewertungen/Meldungen für den Rückblick nicht geladen",
        );
        return { ratings: new Map(), reported: new Set() };
      }
    },

    async rate(questionId, guestId, value) {
      return guarded("question_rate", deps.repos.ratings.rate(questionId, guestId, value, new Date(deps.clock.now())));
    },

    async report(input) {
      const key = `${input.guestId}\u0000${input.questionId}`;
      if (reporting.has(key)) return "duplicate";
      reporting.add(key);
      try {
        const already = await guarded(
          "question_report",
          deps.repos.reports.findReportedQuestionIds(input.guestId, [input.questionId]),
        );
        if (already.has(input.questionId)) return "duplicate";
        await guarded("question_report", deps.repos.reports.create(input, new Date(deps.clock.now())));
        try {
          await guarded("question_report", deps.repos.questions.incrementReports(input.questionId));
        } catch (error) {
          // Die Meldung selbst ist gespeichert (Prüf-Queue); nur der Zähler an der Frage fehlt.
          log.warn({ err: error, question: input.questionId }, "Meldungszähler der Frage nicht erhöht");
        }
        return "created";
      } finally {
        reporting.delete(key);
      }
    },
  };
}
