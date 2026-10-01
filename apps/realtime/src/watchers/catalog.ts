/**
 * Change-Stream-Watcher für den Fragenkatalog (docs/04 §Change-Stream-Watcher, docs/02 §MongoDB):
 *
 * | Watcher | Collection | Relevante Update-Felder | Reaktion |
 * |---|---|---|---|
 * | `questions` | questions | status, category, topic, difficulty, lang | Pool-Eintrag angleichen bzw. entfernen |
 * | `categories` | categories | name, icon, color, playable, active, order | spielbare Kategorie angleichen bzw. entfernen |
 *
 * Beide über `watchWithResume` (Resume-Token im Speicher, Backoff, `startAfter`); Updates liefern per
 * `updateLookup` das aktuelle Dokument mit – dank `$match` nur für die seltenen relevanten Updates, nie für
 * Statistik-Änderungen. `onReset` (Token ungültig, Stream invalidiert, Änderung nicht verarbeitbar) löst einen
 * Vollreload aus; jeder Neustart zählt als Metrik `qm_change_stream_restarts_total{stream, reason}`.
 */
import type { WatchHandle } from "@quizmaster/db";
import { watchWithResume } from "@quizmaster/db";
import type { CategoryDoc, QuestionDoc } from "@quizmaster/shared/documents";
import type { Collection } from "mongodb";
import { type Logger, toDbLogger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import { relevantChangesPipeline } from "./pipeline.ts";

/** Felder einer Frage, die den Pool betreffen (Statistik-Felder gehören ausdrücklich nicht dazu). */
export const QUESTION_POOL_FIELDS = ["status", "category", "topic", "difficulty", "lang"] as const;
/** Felder einer Kategorie, die das Angebot betreffen (Zähler ändern `playable`, das reicht). */
export const CATEGORY_OFFER_FIELDS = ["name", "icon", "color", "playable", "active", "order"] as const;

/** Stream-Namen für Logs und Metriken. */
export const CATALOG_STREAMS = { questions: "questions", categories: "categories" } as const;

/** Ziel der Katalog-Watcher (der Fragen-Service). */
export interface CatalogChangeTarget {
  /** Frage angleichen: aktuelles Dokument (ungeprüft) oder `null`, wenn es nicht mehr existiert. */
  syncQuestion(questionId: string, doc: unknown): void;
  removeQuestion(questionId: string): void;
  /** Kategorie angleichen: aktuelles Dokument (ungeprüft) oder `null`. */
  syncCategory(categoryId: string, doc: unknown): void;
  removeCategory(categoryId: string): void;
  /** Vollreload von Pool und Kategorien; wirft bei Fehlern (der Watcher wiederholt ihn dann). */
  reload(reason: string): Promise<void>;
}

export interface CatalogWatcherDeps {
  questions: Collection<QuestionDoc>;
  categories: Collection<CategoryDoc>;
  target: CatalogChangeTarget;
  logger: Logger;
  metrics: RealtimeMetrics;
  /** Nur Tests: kürzere Pausen beim Neustart. */
  backoff?: { initialMs?: number; maxMs?: number };
}

export interface CatalogWatchers {
  readonly questions: WatchHandle;
  readonly categories: WatchHandle;
  /** Beide Streams offen (Änderungen danach kommen sicher an). */
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

function restartHandlers(stream: string, deps: CatalogWatcherDeps) {
  return {
    async onReset(reason: string) {
      deps.metrics.recordChangeStreamRestart(stream, reason);
      deps.logger.warn({ stream, reason }, "Change Stream neu gestartet – Vollreload des Katalogs");
      await deps.target.reload(`${stream}_${reason}`);
    },
    onError(error: unknown, retry: { attempt: number; delayMs: number }) {
      deps.metrics.recordChangeStreamRestart(stream, "error");
      deps.logger.warn(
        { err: error, stream, attempt: retry.attempt, delayMs: retry.delayMs },
        "Change Stream: Neustart",
      );
    },
    onOpen(info: { resumed: boolean }) {
      deps.logger.debug({ stream, resumed: info.resumed }, "Change Stream offen");
    },
  };
}

/** Startet beide Katalog-Watcher (vor dem Laden des Anfangsbestands aufrufen und `ready` abwarten). */
export function startCatalogWatchers(deps: CatalogWatcherDeps): CatalogWatchers {
  const dbLogger = toDbLogger(deps.logger);
  const backoff = deps.backoff ?? {};

  const questions = watchWithResume(
    deps.questions,
    relevantChangesPipeline(QUESTION_POOL_FIELDS),
    {
      onChange(change) {
        const questionId = String(change.documentKey._id);
        if (change.operationType === "delete") {
          deps.target.removeQuestion(questionId);
          return;
        }
        deps.target.syncQuestion(questionId, change.fullDocument ?? null);
      },
      ...restartHandlers(CATALOG_STREAMS.questions, deps),
    },
    { fullDocument: "updateLookup", logger: dbLogger, name: CATALOG_STREAMS.questions, backoff },
  );

  const categories = watchWithResume(
    deps.categories,
    relevantChangesPipeline(CATEGORY_OFFER_FIELDS),
    {
      onChange(change) {
        const categoryId = String(change.documentKey._id);
        if (change.operationType === "delete") {
          deps.target.removeCategory(categoryId);
          return;
        }
        deps.target.syncCategory(categoryId, change.fullDocument ?? null);
      },
      ...restartHandlers(CATALOG_STREAMS.categories, deps),
    },
    { fullDocument: "updateLookup", logger: dbLogger, name: CATALOG_STREAMS.categories, backoff },
  );

  return {
    questions,
    categories,
    ready: Promise.all([questions.ready, categories.ready]).then(() => undefined),
    async close() {
      await Promise.all([questions.close(), categories.close()]);
    },
  };
}
