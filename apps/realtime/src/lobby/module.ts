/**
 * Modul „Lobby & Spiel“: registriert die Handler aller Lobby-/Spiel-Events und baut beim Start die
 * Laufzeit aus Fragen-Service (Pool + Change Streams), Feedback-Service und Lobby-Registry.
 *
 * - `setup` registriert nur Handler und Hooks; alles, was Datenbank, `io` oder Dienste braucht, entsteht erst
 *   in `onStart` (vor `listen`) – so bleibt `setup` auch mit einem Teil-Kontext (Registry-Tests) lauffähig.
 * - `onDisconnect` → `lobbies.socketDisconnected` (DISCONNECT, sobald der letzte Socket einer Person in der
 *   Lobby weg ist).
 * - `onShutdown` (nach `notice SERVER_RESTART`, vor dem Schließen der Sockets): alle Lobbys einfrieren und ihre
 *   Snapshots schreiben, laufende Spielabschlüsse befristet abwarten, Change Streams schließen.
 * - Produktion (`databaseKind = production`): Start nur mit brauchbarem Fragenkatalog (sonst Exit 1), danach
 *   meldet `/healthz` 503, solange der Katalog unbrauchbar ist (Health-Prüfung `catalog`).
 *
 * Zugriff für andere Module (z. B. die Wiederaufnahme aus Snapshots, `resume/` – in der Modul-Reihenfolge danach)
 * und Tests: `gameRuntimeOf(context)` bzw. `gameRuntimeOf(app)` – ab `onStart` dieses Moduls verfügbar.
 */
import type { Rng } from "@quizmaster/game-engine";
import { createCryptoRng } from "@quizmaster/game-engine/crypto-rng";
import { registerDevHandlers } from "../handlers/dev.ts";
import { registerFeedbackHandlers } from "../handlers/feedback.ts";
import { registerGameHandlers } from "../handlers/game.ts";
import { registerLobbyHandlers } from "../handlers/lobby.ts";
import type { AppServer, ModuleContext, RealtimeModule } from "../registry/types.ts";
import type { AppConfigService } from "../services/app-config.ts";
import { createFeedbackService, type FeedbackService } from "../services/feedback.ts";
import { createOriginRetention, type OriginRetention } from "../services/origin-retention.ts";
import { createQuestionService, type QuestionService } from "../services/questions.ts";
import { createLobbyRegistry, type LobbyRegistry } from "./lobby-registry.ts";

export interface GameRuntime {
  readonly lobbies: LobbyRegistry;
  readonly questions: QuestionService;
  readonly feedback: FeedbackService;
  /** Entfernt die Herkunft älterer Meldungen/Bewertungen (ADR-058, ab `start()` stündlich). */
  readonly originRetention: OriginRetention;
  readonly appConfig: AppConfigService;
  /** Fragenkatalog laden und Change Streams öffnen. */
  start(): Promise<void>;
  /** Lobbys sichern, Change Streams schließen (idempotent, wirft nie). */
  shutdown(reason: string): Promise<void>;
}

export interface GameRuntimeOptions {
  /** Zufall für Engine, Kategorien, Fragen und Bots (Standard: `crypto.randomInt`). */
  rng?: Rng;
  /** Entprellung der Lobby-Snapshots. */
  snapshotDebounceMs?: number;
  /** Sicherheitsnetz-Reload des Katalogs (Standard 30 min). */
  catalogReloadIntervalMs?: number;
  /** Nur Tests: kürzere Neustart-Pausen der Change Streams. */
  watchBackoff?: { initialMs?: number; maxMs?: number };
}

/** Baut die Laufzeit aus dem Modul-Kontext (erst in `onStart` aufrufen). */
export function createGameRuntime(context: ModuleContext, options: GameRuntimeOptions = {}): GameRuntime {
  const { env, io, db, logger, clock, services } = context;
  const rng = options.rng ?? createCryptoRng();
  const production = env.databaseKind === "production";
  const questions = createQuestionService({
    repos: db.repos,
    collections: db.collections,
    pool: env.QUESTION_POOL,
    appConfig: services.appConfig,
    rng,
    clock,
    logger,
    metrics: services.metrics,
    requireUsableCatalog: production,
    ...(options.catalogReloadIntervalMs === undefined ? {} : { reloadIntervalMs: options.catalogReloadIntervalMs }),
    ...(options.watchBackoff === undefined ? {} : { watchBackoff: options.watchBackoff }),
  });
  const feedback = createFeedbackService({ repos: db.repos, clock, logger, metrics: services.metrics });
  const originRetention = createOriginRetention({ repos: db.repos, clock, logger, metrics: services.metrics });
  const lobbies = createLobbyRegistry({
    io,
    clock,
    rng,
    logger,
    metrics: services.metrics,
    timing: env.GAME_TIMING,
    admission: services.admission,
    repos: db.repos,
    questions,
    ...(options.snapshotDebounceMs === undefined ? {} : { snapshotDebounceMs: options.snapshotDebounceMs }),
  });
  let stopping: Promise<void> | undefined;
  return {
    lobbies,
    questions,
    feedback,
    originRetention,
    appConfig: services.appConfig,
    async start() {
      await questions.start();
      originRetention.start();
      if (production) services.health.register("catalog", () => questions.catalog().usable);
    },
    shutdown(reason) {
      stopping ??= (async () => {
        originRetention.stop();
        const results = await Promise.allSettled([lobbies.shutdown(), questions.stop()]);
        for (const result of results) {
          if (result.status === "rejected")
            logger.error({ err: result.reason, reason }, "Lobby-Shutdown unvollständig");
        }
      })();
      return stopping;
    },
  };
}

const runtimes = new WeakMap<AppServer, GameRuntime>();

/** Laufzeit einer App bzw. eines Modul-Kontexts (`undefined` vor dem Start oder ohne dieses Modul). */
export function gameRuntimeOf(owner: { readonly io: AppServer }): GameRuntime | undefined {
  return runtimes.get(owner.io);
}

export function createLobbyGameModule(options: GameRuntimeOptions = {}): RealtimeModule {
  return {
    name: "lobby-game",
    setup(context) {
      let runtime: GameRuntime | undefined;
      const access = (): GameRuntime => {
        if (runtime === undefined) throw new Error("Lobby-Schicht ist nicht gestartet");
        return runtime;
      };
      registerLobbyHandlers(context.registerEvent, access);
      registerGameHandlers(context.registerEvent, access);
      registerFeedbackHandlers(context.registerEvent, access);
      registerDevHandlers(context.registerEvent, access);
      context.onStart(async () => {
        runtime = createGameRuntime(context, options);
        runtimes.set(context.io, runtime);
        await runtime.start();
      });
      context.onDisconnect((socket) => {
        runtime?.lobbies.socketDisconnected(socket);
      });
      context.onShutdown(async (reason) => {
        await runtime?.shutdown(reason);
      });
    },
  };
}

/** Standard-Instanz für `REALTIME_MODULES`. */
export const lobbyGameModule: RealtimeModule = createLobbyGameModule();
