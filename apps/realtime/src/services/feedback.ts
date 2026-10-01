/**
 * Bewertungen und Meldungen aus „Fragen ansehen“ (docs/01 §Spielende, docs/05 `game:review`,
 * `question:rate`, `question:report`; docs/08 §5).
 *
 * - `rate`: eine Bewertung je Gast und Frage, überschreibbar (`questionRatings._id = questionId:guestId`); Bewertung
 *   und Zähler `stats.likes/dislikes` der Frage ändern sich atomar (Transaktion im Repository).
 * - `report`: eine Meldung je Gast und Frage (weitere Meldungen derselben Person werden still ignoriert);
 *   `stats.reports` der Frage zählt mit.
 * - Nach jeder Bewertung bzw. neuen Meldung prüft die Schutzautomatik (`./quality.ts`) die Schwellen und nimmt die
 *   Frage bei Bedarf sofort aus dem Pool. Fehler der Prüfung werden geloggt und gezählt, brechen das gespeicherte
 *   Feedback aber nie ab (die nächste Meldung/Bewertung prüft erneut).
 * - `reviewContext`: eigene Bewertungen/Meldungen für den Rückblick; bei DB-Problemen ohne diese Markierungen
 *   (der Rückblick selbst kommt aus dem Speicher und bleibt verfügbar).
 *
 * Alle Aufrufe sind befristet; Fragen-IDs sind hier immer DB-IDs (die Handler bilden Instanz-IDs vorher über
 * `findShownQuestion` ab – nur in diesem Spiel gezeigte Fragen).
 */
import type { QuestionPool, QuestionQualityState, RatingChange, Repositories } from "@quizmaster/db";
import type { ReviewContext } from "@quizmaster/game-engine";
import type { RatingValue, ReportReason } from "@quizmaster/shared";
import type { Logger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import { TimeoutError, withTimeout } from "../registry/util.ts";
import type { AppConfigService } from "./app-config.ts";
import { createQualityService, type QualityCheck, type QualityService } from "./quality.ts";

/** Frist je Datenbank-Aufruf. */
export const FEEDBACK_TIMEOUT_MS = 5_000;
/**
 * Gesamtbudget je Bewertung bzw. Meldung inklusive Schutzautomatik – klar unter der Handler-Frist (15 s). Die
 * Prüfung bekommt nur die Restzeit; ist nichts mehr übrig, wird sie geloggt übersprungen (die nächste Meldung bzw.
 * Bewertung prüft erneut), sodass ein langsamer Datenbankzugriff nie das Ack kostet.
 */
export const FEEDBACK_BUDGET_MS = 12_000;

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
  /** Schutzautomatik und Live-Zähler (auch für Tests und Diagnose). */
  readonly quality: QualityService;
}

export interface FeedbackServiceDeps {
  repos: Pick<Repositories, "ratings" | "reports" | "questions" | "categories" | "appConfig">;
  clock: { now(): number };
  logger: Logger;
  metrics: RealtimeMetrics;
  timeoutMs?: number;
  /** Gesamtbudget je Aufruf inkl. Schutzautomatik (Standard `FEEDBACK_BUDGET_MS`). */
  budgetMs?: number;
  /** `QUESTION_POOL` für die Live-Zähler (Standard `all`). */
  pool?: QuestionPool;
  /** appConfig im Speicher (Mindestmenge live); ohne: aus der Datenbank. */
  appConfig?: Pick<AppConfigService, "get">;
  /** Schutzautomatik (Standard: aus denselben Abhängigkeiten gebaut). */
  quality?: QualityService;
}

export function createFeedbackService(deps: FeedbackServiceDeps): FeedbackService {
  const timeoutMs = deps.timeoutMs ?? FEEDBACK_TIMEOUT_MS;
  const budgetMs = deps.budgetMs ?? FEEDBACK_BUDGET_MS;
  const log = deps.logger.child({ component: "feedback" });
  const quality =
    deps.quality ??
    createQualityService({
      repos: deps.repos,
      clock: deps.clock,
      logger: deps.logger,
      metrics: deps.metrics,
      timeoutMs,
      ...(deps.pool === undefined ? {} : { pool: deps.pool }),
      ...(deps.appConfig === undefined ? {} : { appConfig: deps.appConfig }),
    });
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

  /**
   * Schutzautomatik nach gespeichertem Feedback, höchstens bis zum Ende des Budgets (`startedAt` aus
   * `performance.now()`): Fehler loggen, nie an den Client weitergeben.
   */
  const check = async (
    trigger: "rating" | "report",
    questionId: string,
    startedAt: number,
    run: () => Promise<QualityCheck>,
  ) => {
    const remaining = Math.floor(startedAt + budgetMs - performance.now());
    if (remaining <= 0) {
      log.warn(
        { question: questionId, trigger },
        "Schutzautomatik übersprungen – Zeitbudget aufgebraucht, die nächste Meldung/Bewertung prüft erneut",
      );
      return;
    }
    const task = run();
    try {
      await withTimeout(task, remaining, "Schutzautomatik");
    } catch (error) {
      log.error(
        { err: error, question: questionId, trigger },
        "Schutzautomatik: Prüfung fehlgeschlagen – Feedback ist gespeichert, die nächste Meldung/Bewertung prüft erneut",
      );
      if (error instanceof TimeoutError) {
        // Die Prüfung läuft im Hintergrund weiter (Schreibzugriffe sind abgesichert) – spätere Fehler ebenfalls loggen.
        task.catch((late: unknown) => {
          log.error(
            { err: late, question: questionId, trigger },
            "Schutzautomatik: Prüfung nach Fristablauf fehlgeschlagen",
          );
        });
      }
    }
  };

  return {
    quality,

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
      const startedAt = performance.now();
      const change = await guarded(
        "question_rate",
        deps.repos.ratings.rate(questionId, guestId, value, new Date(deps.clock.now())),
      );
      await check("rating", questionId, startedAt, () => quality.afterRating(questionId, change));
      return change;
    },

    async report(input) {
      const startedAt = performance.now();
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
        let state: QuestionQualityState | null | undefined;
        try {
          state = await guarded("question_report", deps.repos.questions.incrementReports(input.questionId));
        } catch (error) {
          // Die Meldung selbst ist gespeichert (Prüf-Queue); nur der Zähler an der Frage fehlt. Die Prüfung lädt den
          // Stand der Frage dann selbst.
          log.warn({ err: error, question: input.questionId }, "Meldungszähler der Frage nicht erhöht");
        }
        await check("report", input.questionId, startedAt, () => quality.afterReport(input.questionId, state));
        return "created";
      } finally {
        reporting.delete(key);
      }
    },
  };
}
