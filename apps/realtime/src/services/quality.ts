/**
 * Fragenqualität im Betrieb (docs/08 §5): Schutzautomatik und Live-Zähler der Kategorien.
 *
 * Schutzautomatik – geprüft nach JEDER Meldung bzw. Bewertung:
 * - offene Meldungen „falsch/veraltet/mehrdeutig“ aus ≥ 3 unabhängigen Quellen in 7 Tagen, ODER
 * - Bewertungsquote (Daumen hoch / alle) < 30 % bei ≥ 20 Bewertungen, die Daumen-runter aus ≥ 3 unabhängigen
 *   Quellen
 * Unabhängig (ADR-058): Über dieselbe IP (HMAC-Schlüssel) oder dieselbe Lobby verbundene Gäste zählen als EINE
 * Quelle – Gast-Sessions kosten nichts, eine Person oder eine Gruppe in einer Lobby zieht so keine Frage allein
 * zurück (die Meldungen stehen trotzdem in der Prüf-Queue).
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
 * Missbrauchsbremse (`AUTO_RETIRE_BUDGET`): zusätzlich zur Unabhängigkeit – ohne Obergrenze könnten wenige
 * unabhängige Quellen jede gezeigte Frage melden und Kategorien unter die Mindestmenge drücken. Höchstens 5 automatische
 * Rückzüge je Kategorie und 20 insgesamt in 24 h; darüber bleibt die fällige Frage im Pool (Meldungen bzw.
 * Bewertungen bleiben in der Prüf-Queue, die nächste Meldung/Bewertung prüft erneut), gezählt in
 * `qm_questions_auto_retire_suppressed_total{reason}` und als Fehler geloggt (je Kategorie höchstens alle 10 min) –
 * der Watchdog alarmiert. Budget prüfen und zurückziehen laufen strikt nacheinander (eine Instanz, ADR-012), damit
 * parallele Prüfungen das Budget nicht gemeinsam überschreiten; ist das Budget nicht lesbar, wird nicht
 * zurückgezogen (fail closed, der Fehler landet wie jeder Prüffehler im Log).
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
  AUTO_RETIRE_BUDGET,
  AUTO_RETIRE_RATING,
  type AutoRetireReason,
  type CategoryRecount,
  hasIndependentDislikes,
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
/** Zähler der wegen erschöpften Budgets NICHT zurückgezogenen (aber fälligen) Fragen. */
export const AUTO_RETIRE_SUPPRESSED_METRIC = "qm_questions_auto_retire_suppressed_total";
/** Bei erschöpftem Budget höchstens ein Fehler-Log je Kategorie in diesem Abstand (sonst debug). */
export const SUPPRESSED_LOG_INTERVAL_MS = 10 * 60_000;

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
   * unbekannt, schon retired oder parallel geändert (dann prüft die nächste Meldung/Bewertung erneut) ·
   * `suppressed`: fällig, aber das Budget der Missbrauchsbremse ist erschöpft – die Frage bleibt im Pool.
   */
  outcome: "retired" | "kept" | "skipped" | "suppressed";
  reason: AutoRetireReason | null;
  /** Unabhängige Quellen der zählenden Meldungen im Fenster (nur bei Meldungen, ADR-058). */
  reporters?: number;
  /** Bewertungen seit der letzten Änderung (nur bei Bewertungen ab 20 insgesamt). */
  ratings?: RatingSummary;
  /** Unabhängige Quellen der Daumen-runter seit der letzten Änderung (nur wenn die Quote greift, ADR-058). */
  dislikeSources?: number;
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
function reasonCounter(registry: Registry, name: string, help: string): Counter<"reason"> {
  const existing = registry.getSingleMetric(name);
  if (existing instanceof Counter) return existing as Counter<"reason">;
  return new Counter({ name, help, labelNames: ["reason"] as const, registers: [registry] });
}

/** Belege einer fälligen Prüfung für Log und Ergebnis. */
type Evidence = Pick<QualityCheck, "reporters" | "ratings" | "dislikeSources">;

/** Erschöpftes Budget der Missbrauchsbremse. */
interface BudgetExhausted {
  scope: "category" | "total";
  used: number;
  limit: number;
}

export function createQualityService(deps: QualityServiceDeps): QualityService {
  const log = deps.logger.child({ component: "quality" });
  const timeoutMs = deps.timeoutMs ?? QUALITY_TIMEOUT_MS;
  const pool: QuestionPool = deps.pool ?? "all";
  const autoRetired = reasonCounter(
    deps.metrics.registry,
    AUTO_RETIRED_METRIC,
    "Von der Schutzautomatik aus dem Pool genommene Fragen je Grund (reports, rating)",
  );
  const suppressed = reasonCounter(
    deps.metrics.registry,
    AUTO_RETIRE_SUPPRESSED_METRIC,
    "Fällige Rückzüge der Schutzautomatik, die das Budget (Missbrauchsbremse) zurückhielt, je Grund",
  );
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

  // Budget prüfen und zurückziehen strikt nacheinander: Jede Prüfung sieht den Stand nach dem vorigen Rückzug.
  let serial: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = serial.then(task, task);
    serial = run.catch(() => undefined);
    return run;
  };

  /** `null` = Budget frei; sonst welches Budget erschöpft ist (zuerst die Kategorie). */
  const budgetExhausted = async (category: string): Promise<BudgetExhausted | null> => {
    const since = new Date(deps.clock.now() - AUTO_RETIRE_BUDGET.windowMs);
    const inCategory = await guarded("auto_retire_budget", deps.repos.questions.countAutoRetiredSince(since, category));
    if (inCategory >= AUTO_RETIRE_BUDGET.perCategory) {
      return { scope: "category", used: inCategory, limit: AUTO_RETIRE_BUDGET.perCategory };
    }
    const total = await guarded("auto_retire_budget", deps.repos.questions.countAutoRetiredSince(since));
    if (total >= AUTO_RETIRE_BUDGET.total) return { scope: "total", used: total, limit: AUTO_RETIRE_BUDGET.total };
    return null;
  };

  const suppressedLoggedAt = new Map<string, number>();
  const reportSuppressed = (
    state: QuestionQualityState,
    reason: AutoRetireReason,
    exhausted: BudgetExhausted,
    evidence: Evidence,
  ) => {
    suppressed.inc({ reason });
    const fields = {
      question: state._id,
      category: state.category,
      reason,
      ...exhausted,
      windowHours: AUTO_RETIRE_BUDGET.windowMs / 3_600_000,
      ...(evidence.reporters === undefined ? {} : { reporters: evidence.reporters }),
      ...(evidence.ratings === undefined ? {} : { likes: evidence.ratings.likes, dislikes: evidence.ratings.dislikes }),
      ...(evidence.dislikeSources === undefined ? {} : { dislikeSources: evidence.dislikeSources }),
    };
    const message =
      "Schutzautomatik: Tagesbudget erschöpft – Frage bleibt im Pool, Meldungen/Bewertungen in der Prüf-Queue " +
      "(Missbrauch? pnpm admin:reports, Runbook docs/06)";
    const at = deps.clock.now();
    const last = suppressedLoggedAt.get(state.category);
    if (last === undefined || at - last >= SUPPRESSED_LOG_INTERVAL_MS) {
      suppressedLoggedAt.set(state.category, at);
      log.error(fields, message);
    } else {
      log.debug(fields, message);
    }
  };

  const retire = async (
    state: QuestionQualityState,
    reason: AutoRetireReason,
    evidence: Evidence,
  ): Promise<QualityCheck> => {
    const result = await exclusive(async (): Promise<BudgetExhausted | boolean> => {
      const exhausted = await budgetExhausted(state.category);
      if (exhausted !== null) return exhausted;
      return guarded(
        "auto_retire",
        deps.repos.questions.autoRetire(state._id, reason, now(), { updatedAt: state.updatedAt }),
      );
    });
    if (typeof result === "object") {
      reportSuppressed(state, reason, result, evidence);
      return { outcome: "suppressed", reason, ...evidence };
    }
    const changed = result;
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
        ...(evidence.dislikeSources === undefined ? {} : { dislikeSources: evidence.dislikeSources }),
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
      const reporters = await guarded("quality_check", deps.repos.reports.countIndependentReporters(questionId, since));
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
      // Erst wenn die Quote greift: Stammen die Daumen-runter aus genug unabhängigen Quellen (ADR-058)?
      const dislikeSources = await guarded(
        "quality_check",
        deps.repos.ratings.dislikeSources(questionId, state.updatedAt),
      );
      if (!hasIndependentDislikes(dislikeSources)) return { outcome: "kept", reason: null, ratings, dislikeSources };
      return retire(state, "rating", { ratings, dislikeSources });
    },

    recountCategory: recount,
  };
}
