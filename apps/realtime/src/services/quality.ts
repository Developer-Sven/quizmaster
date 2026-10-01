/**
 * Fragenqualität im Betrieb (docs/08 §5): Schutzautomatik und Live-Zähler der Kategorien.
 *
 * Schutzautomatik – geprüft nach JEDER Meldung bzw. Bewertung:
 * - ≥ 3 offene Meldungen „falsch/veraltet/mehrdeutig“ von verschiedenen Gästen in 7 Tagen, ODER
 * - Bewertungsquote (Daumen hoch / alle) < 30 % bei ≥ 20 Bewertungen
 * → Frage sofort aus dem Pool: DB-Status `retired` + `autoRetired { reason, at }`. Der bestehende
 * questions-Watcher (`src/watchers/catalog.ts`) entfernt sie live aus dem Pool; in der Prüf-Queue
 * (`pnpm admin:reports`) steht sie, bis sie geprüft ist (Seed nach Korrektur oder `--restore`).
 *
 * Gezählt wird ab der letzten Inhalts-/Statusänderung der Frage (`updatedAt`): Feedback zu einer schon geprüften
 * Fassung zieht sie nicht erneut zurück. Idempotent und race-sicher: `autoRetire` schreibt nur, solange die Frage
 * nicht retired und seit dem gelesenen Stand unverändert ist (paralleler Seed, Wiederherstellung) – parallele
 * Prüfungen ziehen sie genau einmal zurück; nur dieser Übergang wird geloggt und gezählt
 * (`qm_questions_auto_retired_total{reason}`).
 *
 * Live-Zähler: Nach jedem Zurückziehen werden `playableCount`/`approvedCount`/`playable` der Kategorie neu
 * berechnet (Mindestmenge `appConfig.catalog.minPlayable`, Pool `QUESTION_POOL`); der Kategorien-Watcher bietet
 * Kategorien unter der Mindestmenge dann nicht mehr an. Neuberechnungen laufen je Kategorie nacheinander; kommt
 * während einer weitere Anforderung, folgt genau eine danach (sie sieht dann alle Änderungen).
 *
 * Logs enthalten nie guestIds (nur Fragen-ID, Kategorie, Grund und Zahlen).
 */
import { Counter, type Registry } from "@prometheus-io/client";
import {
  AUTO_RETIRE_RATING,
  type AutoRetireReason,
  type CategoryRecount,
  isRatingRetireDue,
  isReportRetireDue,
  type QuestionPool,
  type QuestionQualityState,
  type RatingChange,
  type RatingSummary,
  type Repositories,
  ratingTotal,
  recountCategory,
  reportWindowStart,
} from "@quizmaster/db";
import type { Logger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import { withTimeout } from "../registry/util.ts";
import type { AppConfigService } from "./app-config.ts";

/** Frist je Datenbank-Aufruf der Prüfung. */
export const QUALITY_TIMEOUT_MS = 5_000;
/** Zähler der automatisch zurückgezogenen Fragen. */
export const AUTO_RETIRED_METRIC = "qm_questions_auto_retired_total";

export interface QualityServiceDeps {
  repos: Pick<Repositories, "questions" | "reports" | "ratings" | "categories" | "appConfig">;
  clock: { now(): number };
  logger: Logger;
  metrics: RealtimeMetrics;
  /** `QUESTION_POOL` für `playable` (Standard `all`, wie der Seed ohne Angabe). */
  pool?: QuestionPool;
  /** appConfig im Speicher (Mindestmenge live); ohne: bei jeder Neuberechnung aus der Datenbank. */
  appConfig?: Pick<AppConfigService, "get">;
  timeoutMs?: number;
}

export interface QualityCheck {
  /**
   * `retired`: diese Prüfung hat die Frage zurückgezogen · `kept`: Schwelle nicht erreicht · `skipped`: Frage
   * unbekannt, schon retired oder parallel geändert (dann prüft die nächste Meldung/Bewertung erneut).
   */
  outcome: "retired" | "kept" | "skipped";
  reason: AutoRetireReason | null;
  /** Verschiedene Gäste mit zählenden Meldungen im Fenster (nur bei Meldungen). */
  reporters?: number;
  /** Bewertungen seit der letzten Änderung (nur bei Bewertungen ab 20 insgesamt). */
  ratings?: RatingSummary;
}

export interface QualityService {
  /** Nach einer neuen Meldung; `state` = Stand nach `incrementReports` (sonst wird er geladen). */
  afterReport(questionId: string, state?: QuestionQualityState | null): Promise<QualityCheck>;
  /** Nach einer Bewertung mit dem Stand aus deren Transaktion. */
  afterRating(questionId: string, change: RatingChange): Promise<QualityCheck>;
  /** Live-Zähler einer Kategorie neu berechnen (je Kategorie nacheinander); `null`, wenn sie fehlt. */
  recountCategory(categoryId: string): Promise<CategoryRecount | null>;
}

/** Counter je Registry genau einmal (mehrere Dienste derselben App teilen ihn). */
function autoRetiredCounter(registry: Registry): Counter<"reason"> {
  const existing = registry.getSingleMetric(AUTO_RETIRED_METRIC);
  if (existing instanceof Counter) return existing as Counter<"reason">;
  return new Counter({
    name: AUTO_RETIRED_METRIC,
    help: "Von der Schutzautomatik aus dem Pool genommene Fragen je Grund (reports, rating)",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
}

export function createQualityService(deps: QualityServiceDeps): QualityService {
  const log = deps.logger.child({ component: "quality" });
  const timeoutMs = deps.timeoutMs ?? QUALITY_TIMEOUT_MS;
  const pool: QuestionPool = deps.pool ?? "all";
  const autoRetired = autoRetiredCounter(deps.metrics.registry);
  const now = () => new Date(deps.clock.now());

  const guarded = async <T>(operation: string, task: Promise<T>): Promise<T> => {
    try {
      return await withTimeout(task, timeoutMs, operation);
    } catch (error) {
      deps.metrics.recordMongoError(operation);
      throw error;
    }
  };

  const minPlayable = async (): Promise<number> => {
    if (deps.appConfig !== undefined) return deps.appConfig.get().catalog.minPlayable;
    return (await guarded("category_counts", deps.repos.appConfig.get())).catalog.minPlayable;
  };

  const runRecount = async (categoryId: string): Promise<CategoryRecount | null> => {
    const rule = { minPlayable: await minPlayable(), pool };
    const result = await guarded("category_counts", recountCategory(deps.repos, categoryId, rule, now()));
    if (result === null) {
      log.warn({ category: categoryId }, "Live-Zähler: Kategorie nicht gefunden");
      return null;
    }
    const { before, after } = result;
    if (before.playable && !after.playable) {
      log.warn(
        { category: categoryId, playableCount: after.playableCount, minPlayable: rule.minPlayable, pool },
        "Kategorie unter der Mindestmenge – wird nicht mehr angeboten",
      );
    } else if (!before.playable && after.playable) {
      log.info(
        { category: categoryId, playableCount: after.playableCount, minPlayable: rule.minPlayable, pool },
        "Kategorie wieder spielbar",
      );
    } else {
      log.debug({ category: categoryId, ...after }, "Live-Zähler neu berechnet");
    }
    return result;
  };

  // Je Kategorie höchstens eine laufende und eine folgende Neuberechnung (wie der Katalog-Reload).
  const running = new Map<string, Promise<CategoryRecount | null>>();
  const queued = new Map<string, Promise<CategoryRecount | null>>();
  const recount = (categoryId: string): Promise<CategoryRecount | null> => {
    const current = running.get(categoryId);
    if (current === undefined) {
      const task = runRecount(categoryId).finally(() => {
        running.delete(categoryId);
      });
      running.set(categoryId, task);
      return task;
    }
    let next = queued.get(categoryId);
    if (next === undefined) {
      // Ergebnis der laufenden egal (Fehler hat ihr Aufrufer bekommen und geloggt) – die folgende zählt neu.
      next = current
        .catch(() => null)
        .then(() => {
          queued.delete(categoryId);
          return recount(categoryId);
        });
      queued.set(categoryId, next);
    }
    return next;
  };

  const retire = async (
    state: QuestionQualityState,
    reason: AutoRetireReason,
    evidence: Pick<QualityCheck, "reporters" | "ratings">,
  ): Promise<QualityCheck> => {
    const changed = await guarded(
      "auto_retire",
      deps.repos.questions.autoRetire(state._id, reason, now(), { updatedAt: state.updatedAt }),
    );
    if (!changed) {
      // Schon zurückgezogen (parallele Prüfung) oder inzwischen geändert (Seed, Wiederherstellung).
      log.debug({ question: state._id, reason }, "Schutzautomatik: Frage schon zurückgezogen oder geändert");
      return { outcome: "skipped", reason, ...evidence };
    }
    autoRetired.inc({ reason });
    log.warn(
      {
        question: state._id,
        category: state.category,
        reason,
        ...(evidence.reporters === undefined ? {} : { reporters: evidence.reporters }),
        ...(evidence.ratings === undefined
          ? {}
          : { likes: evidence.ratings.likes, dislikes: evidence.ratings.dislikes }),
      },
      "Schutzautomatik: Frage aus dem Pool genommen (Prüf-Queue: pnpm admin:reports)",
    );
    try {
      await recount(state.category);
    } catch (error) {
      // Die Frage ist zurückgezogen (Pool-Watcher); nur der Zähler bleibt bis zum nächsten Seed bzw. zur
      // nächsten Neuberechnung dieser Kategorie stehen.
      log.error({ err: error, category: state.category }, "Live-Zähler der Kategorie nicht neu berechnet");
    }
    return { outcome: "retired", reason, ...evidence };
  };

  return {
    async afterReport(questionId, state) {
      // `undefined` = Stand unbekannt (Zähler nicht erhöht) → laden; `null` = Frage gibt es nicht.
      const current =
        state === undefined ? await guarded("quality_check", deps.repos.questions.findQualityState(questionId)) : state;
      if (current === null || current.status === "retired") return { outcome: "skipped", reason: null };
      const since = reportWindowStart(now(), current.updatedAt);
      const reporters = await guarded("quality_check", deps.repos.reports.countDistinctReporters(questionId, since));
      if (!isReportRetireDue(reporters)) return { outcome: "kept", reason: null, reporters };
      return retire(current, "reports", { reporters });
    },

    async afterRating(questionId, change) {
      const state = change.question;
      if (state === null || state.status === "retired") return { outcome: "skipped", reason: null };
      // Vorfilter ohne DB-Zugriff: Die Zähler der Frage (alle Fassungen, dank atomarer Bewertungen konsistent) sind
      // nie kleiner als die Bewertungen seit ihrer letzten Änderung – unter 20 insgesamt greift die Schwelle nicht.
      if (ratingTotal(state.stats) < AUTO_RETIRE_RATING.minRatings) return { outcome: "kept", reason: null };
      const ratings = await guarded("quality_check", deps.repos.ratings.summary(questionId, state.updatedAt));
      if (!isRatingRetireDue(ratings)) return { outcome: "kept", reason: null, ratings };
      return retire(state, "rating", { ratings });
    },

    recountCategory: recount,
  };
}
