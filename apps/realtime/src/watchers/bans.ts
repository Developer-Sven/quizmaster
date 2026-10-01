/**
 * Change-Stream-Watcher auf `bans` (docs/04 §Change-Stream-Watcher, docs/06 §Notfall-Runbook „betroffene Gäste
 * bannen“): Jede neue oder geänderte, noch gültige Sperre trennt sofort alle Sockets des Gasts bzw. des
 * IP-Schlüssels – `kicked { reason: "abuse" }`, dann trennen (`BansService.disconnectBanned`). Ein erneuter
 * Verbindungsversuch scheitert an der Ban-Prüfung im Handshake (`BANNED`). Aufheben (delete) braucht keine
 * Reaktion; Updates kommen per `updateLookup` mit dem aktuellen Dokument.
 *
 * Neustart ohne Resume-Token (Token ungültig, Stream invalidiert, Änderung nicht verarbeitbar): Änderungen können
 * gefehlt haben → `onReset` gleicht alle verbundenen Sockets mit der Datenbank ab (`sweep`). Jeder Neustart zählt
 * als Metrik `qm_change_stream_restarts_total{stream="bans", reason}`.
 */
import type { WatchHandle } from "@quizmaster/db";
import { watchWithResume } from "@quizmaster/db";
import { type BanDoc, banDocSchema } from "@quizmaster/shared/documents";
import type { Collection } from "mongodb";
import { type Logger, type SecurityLog, toDbLogger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import type { Clock } from "../registry/types.ts";
import type { BansService } from "../services/bans.ts";

/** Stream-Name für Logs und Metriken. */
export const BANS_STREAM = "bans";

export interface BansWatcherDeps {
  collection: Collection<BanDoc>;
  bans: Pick<BansService, "disconnectBanned">;
  /** Vollabgleich aller verbundenen Sockets (nach einem Reset); liefert die Zahl getrennter Sockets. */
  sweep: () => Promise<number>;
  clock: Clock;
  logger: Logger;
  metrics: Pick<RealtimeMetrics, "recordChangeStreamRestart">;
  security: Pick<SecurityLog, "record">;
  /** Nur Tests: kürzere Pausen beim Neustart. */
  backoff?: { initialMs?: number; maxMs?: number };
}

/** Ist die Sperre zum Zeitpunkt `now` (ms) in Kraft? */
export function isBanActive(ban: Pick<BanDoc, "expiresAt">, now: number): boolean {
  return ban.expiresAt === undefined || ban.expiresAt.getTime() > now;
}

/** Startet den Watcher (vor dem Abgleich aufrufen und `ready` abwarten). */
export function startBansWatcher(deps: BansWatcherDeps): WatchHandle {
  const { logger, metrics } = deps;
  return watchWithResume(
    deps.collection,
    [],
    {
      onChange(change) {
        if (change.operationType === "delete") return;
        if (change.fullDocument === undefined || change.fullDocument === null) return;
        const parsed = banDocSchema.safeParse(change.fullDocument);
        if (!parsed.success) {
          // Nur aus Code/Admin-CLI geschrieben (zod-validiert) – ein ungültiges Dokument ist ein Betriebsfehler.
          logger.error({ stream: BANS_STREAM }, "Sperre im Change Stream ungültig – ignoriert");
          return;
        }
        const ban = parsed.data;
        if (!isBanActive(ban, deps.clock.now())) return;
        const sockets = deps.bans.disconnectBanned(ban);
        if (sockets > 0) {
          deps.security.record("ban", "watcher_disconnect");
          logger.warn({ kind: ban.kind, sockets }, "Gesperrte Verbindungen sofort getrennt");
        }
      },
      async onReset(reason) {
        metrics.recordChangeStreamRestart(BANS_STREAM, reason);
        logger.warn({ stream: BANS_STREAM, reason }, "Change Stream neu gestartet – Abgleich aller Verbindungen");
        const sockets = await deps.sweep();
        if (sockets > 0) logger.warn({ sockets }, "Abgleich: gesperrte Verbindungen getrennt");
      },
      onError(error, retry) {
        metrics.recordChangeStreamRestart(BANS_STREAM, "error");
        logger.warn(
          { err: error, stream: BANS_STREAM, attempt: retry.attempt, delayMs: retry.delayMs },
          "Change Stream: Neustart",
        );
      },
      onOpen(info) {
        logger.debug({ stream: BANS_STREAM, resumed: info.resumed }, "Change Stream offen");
      },
    },
    {
      operationTypes: ["insert", "update", "replace"],
      fullDocument: "updateLookup",
      logger: toDbLogger(logger),
      name: BANS_STREAM,
      ...(deps.backoff === undefined ? {} : { backoff: deps.backoff }),
    },
  );
}
