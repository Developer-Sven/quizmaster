/**
 * Fragen-Service (docs/04 §Fragenauswahl 1–5, §Change-Stream-Watcher): Fragenpool und spielbare Kategorien im
 * Speicher des Realtime-Servers, Kategorien anbieten, Fragen ziehen und laden.
 *
 * 1. Pool: `questions.loadPool(QUESTION_POOL)` (Projektion `{ _id, category, topic, difficulty }`, `all` =
 *    unverified + approved, `approved` = nur belegte) und `categories.listPlayable()`; Schwierigkeitsmix live
 *    aus `appConfig.catalog.difficultyMix` (ADR-021, Realtime liest nie `content/`).
 * 2. Live: Die Katalog-Watcher (`src/watchers/catalog.ts`) melden relevante Änderungen (`syncQuestion`,
 *    `syncCategory`, …). Reihenfolge beim Start wie von `watchWithResume` verlangt: Streams öffnen → `ready`
 *    abwarten → Anfangsbestand laden. Vollreload bei `onReset` und als Sicherheitsnetz alle 30 min; Änderungen,
 *    die während eines Reloads eintreffen, werden danach erneut angewendet (sonst überschriebe der ältere
 *    Reload-Stand sie). Läuft schon ein Reload, folgt genau einer danach.
 * 3./4. `offerCategories` und `drawQuestions` sind die reinen Auswahlfunktionen der Engine (Kategorien mit genug
 *    ungesehenen Fragen zuerst, Schwierigkeit nach Katalog-Mix, verschiedene Themen …).
 * 5. `loadQuestions` zieht, lädt die Volldokumente (`findForPlay`, `$in`, Frist deutlich unter der Engine-Frist
 *    `SHELL_REQUEST_TIMEOUT_MS`), prüft sie (spielbarer Status, Kategorie, Schema der Engine) und zieht einmal
 *    nach, falls eine Frage inzwischen fehlt oder nicht mehr spielbar ist (sie fliegt dann auch aus dem Pool).
 */
import type { QuestionPool as QuestionPoolKind, Repositories } from "@quizmaster/db";
import {
  type CategoryOffer,
  drawQuestions,
  offerCategories,
  type PoolQuestion,
  type QuestionInput,
  questionInputSchema,
  type Rng,
  type SeenQuestions,
  type TurnRef,
} from "@quizmaster/game-engine";
import { type CategoryOption, categoryOptionSchema } from "@quizmaster/shared";
import { isPlayableStatus } from "@quizmaster/shared/content";
import type { CategoryDoc, QuestionDoc } from "@quizmaster/shared/documents";
import { categoryDocSchema, questionDocSchema } from "@quizmaster/shared/documents";
import type { Collection } from "mongodb";
import type { Logger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import { withTimeout } from "../registry/util.ts";
import { type CatalogChangeTarget, type CatalogWatchers, startCatalogWatchers } from "../watchers/catalog.ts";
import type { AppConfigService } from "./app-config.ts";

/** Sicherheitsnetz: Vollreload des Katalogs (docs/04 §Fragenauswahl 2). */
export const CATALOG_RELOAD_INTERVAL_MS = 30 * 60_000;
/** Frist eines Vollreloads (Pool + Kategorien). */
export const CATALOG_RELOAD_TIMEOUT_MS = 30_000;
/** Frist für das Laden der Volldokumente eines Zuges (zwei Versuche bleiben weit unter 20 s Engine-Frist). */
export const QUESTION_FETCH_TIMEOUT_MS = 5_000;
/** So lange wartet der Start höchstens darauf, dass die Change Streams offen sind. */
export const WATCH_READY_TIMEOUT_MS = 10_000;
/** Ziehungen je Zug: die erste und höchstens eine Nachziehung für fehlende/nicht mehr spielbare Fragen. */
const DRAW_ROUNDS = 2;

/** Pool-relevante Felder einer Frage (Watcher-Dokumente werden damit geprüft, alles andere verworfen). */
const questionStateSchema = questionDocSchema.pick({
  _id: true,
  category: true,
  topic: true,
  difficulty: true,
  status: true,
});
const poolEntrySchema = questionDocSchema.pick({ _id: true, category: true, topic: true, difficulty: true });
const categoryStateSchema = categoryDocSchema.pick({
  _id: true,
  name: true,
  icon: true,
  color: true,
  playable: true,
  order: true,
});

export interface LoadQuestionsRequest {
  categoryId: string;
  /** K = Fragen pro Kategorie. */
  count: number;
  /** Im Spiel bereits benutzte Fragen (nie doppelt). */
  excludeQuestionIds: readonly string[];
  seen: SeenQuestions;
}

export interface LoadedQuestions {
  /** 0 … K geprüfte Fragen (Engine-Eingabe; ohne `source`, `stats` …). */
  questions: QuestionInput[];
  /** Davon mit schon gesehenen Fragen aufgefüllt (docs/04: im Log vermerken). */
  refilledSeen: number;
}

export interface QuestionServiceStats {
  questions: number;
  categories: number;
  /** Angewendete Änderungen aus den Change Streams. */
  changesApplied: number;
  reloads: number;
  lastReloadAt: number | null;
}

export interface QuestionService extends CatalogChangeTarget {
  /** Watcher starten, `ready` abwarten (höchstens 10 s), Anfangsbestand laden, 30-min-Reload planen. */
  start(): Promise<void>;
  /** Watcher schließen, Reload-Timer stoppen. Idempotent. */
  stop(): Promise<void>;
  /** 3 Kategorien für den nächsten Zug oder `null` (→ LOAD_FAILED). */
  offerCategories(turn: TurnRef, seen: SeenQuestions): CategoryOffer | null;
  /** Fragen eines Zuges ziehen und laden (Frist, Prüfung, einmal nachziehen). */
  loadQuestions(request: LoadQuestionsRequest): Promise<LoadedQuestions>;
  /** Spielbare Kategorien in Anzeigereihenfolge. */
  playableCategories(): CategoryOption[];
  hasQuestion(questionId: string): boolean;
  /** Anzahl spielbarer Fragen einer Kategorie im Pool. */
  poolSize(categoryId?: string): number;
  stats(): QuestionServiceStats;
}

export interface QuestionServiceDeps {
  repos: Pick<Repositories, "questions" | "categories">;
  collections: { questions: Collection<QuestionDoc>; categories: Collection<CategoryDoc> };
  /** `QUESTION_POOL` (all | approved). */
  pool: QuestionPoolKind;
  appConfig: Pick<AppConfigService, "get">;
  rng: Rng;
  clock: { now(): number };
  logger: Logger;
  metrics: RealtimeMetrics;
  /** Change Streams starten (Standard true; Unit-Tests ohne Replica Set: false). */
  watch?: boolean;
  reloadIntervalMs?: number;
  fetchTimeoutMs?: number;
  /** Nur Tests: kürzere Pausen der Watcher beim Neustart. */
  watchBackoff?: { initialMs?: number; maxMs?: number };
}

interface CategoryEntry {
  option: CategoryOption;
  order: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

export function createQuestionService(deps: QuestionServiceDeps): QuestionService {
  const log = deps.logger.child({ component: "questions" });
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? QUESTION_FETCH_TIMEOUT_MS;

  // Pool: id → Eintrag und Kategorie → (id → Eintrag); Arrays je Kategorie für die Engine werden gecacht.
  let entries = new Map<string, PoolQuestion>();
  let byCategory = new Map<string, Map<string, PoolQuestion>>();
  let views = new Map<string, PoolQuestion[]>();
  let categories = new Map<string, CategoryEntry>();
  let categoryList: CategoryOption[] | null = null;

  let changesApplied = 0;
  let reloads = 0;
  let lastReloadAt: number | null = null;
  let buffering = false;
  let buffered: Array<() => void> = [];
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  let watchers: CatalogWatchers | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const removeFromCategory = (entry: PoolQuestion) => {
    const bucket = byCategory.get(entry.category);
    if (bucket === undefined) return;
    bucket.delete(entry.id);
    if (bucket.size === 0) byCategory.delete(entry.category);
    views.delete(entry.category);
  };

  const putEntry = (entry: PoolQuestion) => {
    const previous = entries.get(entry.id);
    if (
      previous !== undefined &&
      previous.category === entry.category &&
      previous.topic === entry.topic &&
      previous.difficulty === entry.difficulty
    ) {
      return;
    }
    if (previous !== undefined) removeFromCategory(previous);
    entries.set(entry.id, entry);
    let bucket = byCategory.get(entry.category);
    if (bucket === undefined) {
      bucket = new Map();
      byCategory.set(entry.category, bucket);
    }
    bucket.set(entry.id, entry);
    views.delete(entry.category);
  };

  const removeEntry = (questionId: string) => {
    const previous = entries.get(questionId);
    if (previous === undefined) return;
    entries.delete(questionId);
    removeFromCategory(previous);
  };

  const poolView = (): Map<string, PoolQuestion[]> => {
    const view = new Map<string, PoolQuestion[]>();
    for (const [categoryId, bucket] of byCategory) {
      let list = views.get(categoryId);
      if (list === undefined) {
        list = [...bucket.values()];
        views.set(categoryId, list);
      }
      view.set(categoryId, list);
    }
    return view;
  };

  const toCategoryEntry = (raw: unknown): { id: string; entry: CategoryEntry | null } | null => {
    const parsed = categoryStateSchema.safeParse(raw);
    if (!parsed.success) return null;
    const doc = parsed.data;
    if (!doc.playable) return { id: doc._id, entry: null };
    const option = categoryOptionSchema.safeParse({ id: doc._id, name: doc.name, icon: doc.icon, color: doc.color });
    if (!option.success) return null;
    return { id: doc._id, entry: { option: option.data, order: doc.order } };
  };

  const playableCategories = (): CategoryOption[] => {
    categoryList ??= [...categories.values()]
      .sort((a, b) => a.order - b.order || a.option.id.localeCompare(b.option.id))
      .map((entry) => entry.option);
    return categoryList;
  };

  /** Wendet eine Änderung an – während eines Reloads zusätzlich gepuffert und nach dem Tausch erneut. */
  const applyChange = (apply: () => void) => {
    changesApplied += 1;
    apply();
    if (buffering) buffered.push(apply);
  };

  const syncQuestion = (questionId: string, doc: unknown) => {
    applyChange(() => {
      if (doc === null || doc === undefined) {
        removeEntry(questionId);
        return;
      }
      const parsed = questionStateSchema.safeParse(doc);
      if (!parsed.success || parsed.data._id !== questionId) {
        log.warn({ question: questionId }, "Frage aus dem Change Stream ungültig – aus dem Pool entfernt");
        removeEntry(questionId);
        return;
      }
      const question = parsed.data;
      if (!isPlayableStatus(question.status, deps.pool)) {
        removeEntry(questionId);
        return;
      }
      putEntry({
        id: question._id,
        category: question.category,
        topic: question.topic,
        difficulty: question.difficulty,
      });
    });
  };

  const removeQuestion = (questionId: string) => {
    applyChange(() => removeEntry(questionId));
  };

  const syncCategory = (categoryId: string, doc: unknown) => {
    applyChange(() => {
      const next = doc === null || doc === undefined ? { id: categoryId, entry: null } : toCategoryEntry(doc);
      if (next === null || next.id !== categoryId) {
        log.warn({ category: categoryId }, "Kategorie aus dem Change Stream ungültig – nicht mehr angeboten");
        categories.delete(categoryId);
      } else if (next.entry === null) {
        categories.delete(categoryId);
      } else {
        categories.set(categoryId, next.entry);
      }
      categoryList = null;
    });
  };

  const removeCategory = (categoryId: string) => {
    applyChange(() => {
      categories.delete(categoryId);
      categoryList = null;
    });
  };

  const runReload = async (reason: string): Promise<void> => {
    buffering = true;
    buffered = [];
    const startedAt = performance.now();
    try {
      const [rawPool, rawCategories] = await withTimeout(
        Promise.all([deps.repos.questions.loadPool(deps.pool), deps.repos.categories.listPlayable()]),
        CATALOG_RELOAD_TIMEOUT_MS,
        "Katalog-Reload",
      );
      const nextEntries = new Map<string, PoolQuestion>();
      const nextByCategory = new Map<string, Map<string, PoolQuestion>>();
      let invalidQuestions = 0;
      for (const raw of rawPool) {
        const parsed = poolEntrySchema.safeParse(raw);
        if (!parsed.success) {
          invalidQuestions += 1;
          continue;
        }
        const entry: PoolQuestion = {
          id: parsed.data._id,
          category: parsed.data.category,
          topic: parsed.data.topic,
          difficulty: parsed.data.difficulty,
        };
        nextEntries.set(entry.id, entry);
        let bucket = nextByCategory.get(entry.category);
        if (bucket === undefined) {
          bucket = new Map();
          nextByCategory.set(entry.category, bucket);
        }
        bucket.set(entry.id, entry);
      }
      const nextCategories = new Map<string, CategoryEntry>();
      let invalidCategories = 0;
      for (const raw of rawCategories) {
        const next = toCategoryEntry(raw);
        if (next === null) invalidCategories += 1;
        else if (next.entry !== null) nextCategories.set(next.id, next.entry);
      }
      // Tausch und erneutes Anwenden der zwischenzeitlichen Änderungen ohne Unterbrechung (ein Tick).
      entries = nextEntries;
      byCategory = nextByCategory;
      views = new Map();
      categories = nextCategories;
      categoryList = null;
      for (const apply of buffered) apply();
      reloads += 1;
      lastReloadAt = deps.clock.now();
      if (invalidQuestions + invalidCategories > 0) {
        log.warn({ invalidQuestions, invalidCategories }, "Ungültige Katalog-Einträge beim Reload übersprungen");
      }
      log.info(
        {
          reason,
          questions: entries.size,
          categories: categories.size,
          replayed: buffered.length,
          ms: Math.round(performance.now() - startedAt),
        },
        "Fragenkatalog geladen",
      );
    } catch (error) {
      deps.metrics.recordMongoError("question_pool");
      log.error({ err: error, reason }, "Fragenkatalog nicht geladen – bisheriger Stand bleibt");
      throw error;
    } finally {
      buffering = false;
      buffered = [];
    }
  };

  const reload = (reason: string): Promise<void> => {
    if (running === null) {
      running = runReload(reason).finally(() => {
        running = null;
      });
      return running;
    }
    // Läuft schon: genau ein weiterer Reload danach (deckt Änderungen ab, die der laufende verpasst haben kann).
    // Ergebnis des laufenden Reloads egal (Fehler hat `runReload` bereits geloggt und gezählt).
    queued ??= running
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return reload(reason);
      });
    return queued;
  };

  /** Prüft ein geladenes Volldokument für den Zug; `null` = nicht (mehr) spielbar. */
  const checkForPlay = (doc: unknown, categoryId: string): QuestionInput | null => {
    const state = questionStateSchema.safeParse(doc);
    if (!state.success || !isPlayableStatus(state.data.status, deps.pool) || state.data.category !== categoryId) {
      return null;
    }
    const input = questionInputSchema.safeParse(doc);
    return input.success ? input.data : null;
  };

  const service: QuestionService = {
    syncQuestion,
    removeQuestion,
    syncCategory,
    removeCategory,
    reload,

    async start() {
      stopped = false;
      if (deps.watch !== false) {
        watchers = startCatalogWatchers({
          questions: deps.collections.questions,
          categories: deps.collections.categories,
          target: service,
          logger: log,
          metrics: deps.metrics,
          ...(deps.watchBackoff === undefined ? {} : { backoff: deps.watchBackoff }),
        });
        const opened = await Promise.race([
          watchers.ready.then(() => true),
          sleep(WATCH_READY_TIMEOUT_MS).then(() => false),
        ]);
        if (!opened) {
          deps.metrics.recordChangeStreamRestart("catalog", "open_timeout");
          log.error(
            { timeoutMs: WATCH_READY_TIMEOUT_MS },
            "Change Streams nicht rechtzeitig offen – Start mit Vollreload, Watcher versuchen es weiter",
          );
        }
      }
      await reload("start");
      const intervalMs = deps.reloadIntervalMs ?? CATALOG_RELOAD_INTERVAL_MS;
      interval = setInterval(() => {
        // Fehler hat `runReload` geloggt und gezählt; der bisherige Stand bleibt, der nächste Lauf versucht es neu.
        reload("interval").catch(() => undefined);
      }, intervalMs);
      interval.unref();
    },

    async stop() {
      stopped = true;
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      const current = watchers;
      watchers = null;
      if (current !== null) await current.close();
    },

    offerCategories(turn, seen) {
      return offerCategories({ categories: playableCategories(), pool: poolView(), seen, turn, rng: deps.rng });
    },

    async loadQuestions(request) {
      if (stopped) throw new Error("Fragen-Service ist gestoppt");
      const exclude = new Set(request.excludeQuestionIds);
      const questions: QuestionInput[] = [];
      let refilledSeen = 0;
      for (let round = 0; round < DRAW_ROUNDS && questions.length < request.count; round++) {
        const drawn = drawQuestions({
          categoryId: request.categoryId,
          count: request.count - questions.length,
          pool: poolView(),
          seen: request.seen,
          usedQuestionIds: exclude,
          difficultyMix: deps.appConfig.get().catalog.difficultyMix,
          rng: deps.rng,
        });
        if (drawn.length === 0) break;
        for (const entry of drawn) exclude.add(entry.id);
        let docs: unknown[];
        try {
          docs = await withTimeout(
            deps.repos.questions.findForPlay(drawn.map((entry) => entry.id)),
            fetchTimeoutMs,
            "Fragen laden",
          );
        } catch (error) {
          deps.metrics.recordMongoError("question_fetch");
          throw error;
        }
        const byId = new Map<string, unknown>();
        for (const doc of docs) {
          const id = (doc as { _id?: unknown })._id;
          if (typeof id === "string") byId.set(id, doc);
        }
        for (const entry of drawn) {
          const checked = checkForPlay(byId.get(entry.id), request.categoryId);
          if (checked === null) {
            // Inzwischen gelöscht oder nicht mehr spielbar – der Watcher meldet das gleich ohnehin.
            removeEntry(entry.id);
            log.warn({ question: entry.id }, "Gezogene Frage nicht mehr spielbar – nachgezogen");
            continue;
          }
          questions.push(checked);
          if (entry.seen) refilledSeen += 1;
        }
      }
      return { questions, refilledSeen };
    },

    playableCategories: () => [...playableCategories()],
    hasQuestion: (questionId) => entries.has(questionId),
    poolSize(categoryId) {
      if (categoryId === undefined) return entries.size;
      return byCategory.get(categoryId)?.size ?? 0;
    },
    stats: () => ({ questions: entries.size, categories: categories.size, changesApplied, reloads, lastReloadAt }),
  };
  return service;
}
