/**
 * Change-Stream-Watcher auf `appConfig` (docs/04 §Change-Stream-Watcher, docs/06 §DDoS-Schicht 6 „Kill-Switches
 * live via Change Stream“): Jede Änderung des Dokuments `_id: "global"` geht über `AppConfigService.apply`
 * (zod) in den Speicher – Wartungsmodus, `lobbyCreationEnabled`, `turnstileOnJoin`, `maxActiveLobbies`,
 * `minClientProtocol` und `blockedTerms` wirken damit ohne Neustart. Die Reaktionen darauf (Hinweis
 * `MAINTENANCE`, veraltete Clients trennen) hängen als Listener am Dienst (`services/security-module.ts`).
 *
 * Ein ungültiges Dokument wird nicht übernommen (die letzte gültige Konfiguration bleibt, fail-safe); nach drei
 * Fehlversuchen überspringt `watchWithResume` die Änderung und `onReset` lädt neu. Gelöschtes Dokument → `load()`
 * (Startwerte, wie nach einem Neustart). Jeder Neustart zählt als Metrik
 * `qm_change_stream_restarts_total{stream="appConfig", reason}`.
 */
import type { WatchHandle } from "@quizmaster/db";
import { watchWithResume } from "@quizmaster/db";
import { APP_CONFIG_ID, type AppConfigDoc } from "@quizmaster/shared/documents";
import type { Collection } from "mongodb";
import { type Logger, toDbLogger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import type { AppConfigService } from "../services/app-config.ts";

/** Stream-Name für Logs und Metriken. */
export const APP_CONFIG_STREAM = "appConfig";

export interface AppConfigWatcherDeps {
  collection: Collection<AppConfigDoc>;
  appConfig: Pick<AppConfigService, "apply" | "load">;
  logger: Logger;
  metrics: Pick<RealtimeMetrics, "recordChangeStreamRestart">;
  /** Nur Tests: kürzere Pausen beim Neustart. */
  backoff?: { initialMs?: number; maxMs?: number };
}

/** Startet den Watcher (danach `ready` abwarten und den Anfangsbestand laden). */
export function startAppConfigWatcher(deps: AppConfigWatcherDeps): WatchHandle {
  const { logger, metrics } = deps;
  return watchWithResume(
    deps.collection,
    // Nur das eine Konfigurationsdokument (die Pipeline stammt aus Code, nie aus Requests).
    [{ $match: { "documentKey._id": APP_CONFIG_ID } }],
    {
      async onChange(change) {
        if (change.operationType === "delete" || change.fullDocument === undefined || change.fullDocument === null) {
          await deps.appConfig.load();
          return;
        }
        // Wirft bei ungültigem Dokument → Wiederholung, danach Reset (die gültige Konfiguration bleibt bis dahin).
        deps.appConfig.apply(change.fullDocument);
      },
      async onReset(reason) {
        metrics.recordChangeStreamRestart(APP_CONFIG_STREAM, reason);
        logger.warn({ stream: APP_CONFIG_STREAM, reason }, "Change Stream neu gestartet – appConfig neu geladen");
        await deps.appConfig.load();
      },
      onError(error, retry) {
        metrics.recordChangeStreamRestart(APP_CONFIG_STREAM, "error");
        logger.warn(
          { err: error, stream: APP_CONFIG_STREAM, attempt: retry.attempt, delayMs: retry.delayMs },
          "Change Stream: Neustart",
        );
      },
      onOpen(info) {
        logger.debug({ stream: APP_CONFIG_STREAM, resumed: info.resumed }, "Change Stream offen");
      },
    },
    {
      fullDocument: "updateLookup",
      logger: toDbLogger(logger),
      name: APP_CONFIG_STREAM,
      ...(deps.backoff === undefined ? {} : { backoff: deps.backoff }),
    },
  );
}
