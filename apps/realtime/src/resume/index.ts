/**
 * Wiederaufnahme laufender Lobbys nach einem Neustart (docs/07 Checkliste Phase 6, docs/12 §Deploy-Strategie
 * „ab Phase 6: laufende Spiele aus Snapshots wiederherstellen“, ADR-012: eine Realtime-Instanz).
 *
 * Beim Start (onStart, nach dem Lobby-Modul und vor `listen`):
 * 1. alle aktiven Lobby-Snapshots laden (`lobbies.listActive`, befristet),
 * 2. je Dokument `fromLobbySnapshot` (Engine): validieren, laufende Phase auf den Anfang der aktuellen Frage bzw.
 *    Kategoriewahl zurücksetzen (neue Zeitstempel, Timer neu, alle Menschen gelten als getrennt),
 * 3. `lobbies.adopt(state)` → Timer, Bots und gesehene Fragen laufen weiter; Clients kommen über
 *    `lobby:resume` zurück (Reconnect-Frist im Spiel 90 s, „niemand verbunden“ schließt nach 60 s),
 * 4. nicht wiederherstellbare Snapshots (ungültig, inkonsistent, ohne Menschen) werden geschlossen (`active:
 *    false`, Code frei) statt den Code bis zum TTL-Ablauf zu blockieren.
 *
 * Fehler beim Laden blockieren den Start nicht (die Start-Checks haben die Datenbank schon geprüft): Die Lobbys
 * bleiben dann in der Datenbank und laufen per TTL aus; Log + `qm_mongo_errors_total{operation="lobby_resume"}`.
 * Ergebnis je Lobby in `qm_lobbies_resumed_total{outcome}`.
 *
 * Eingebunden in `index.ts` (Produktion) hinter `REALTIME_MODULES`; Tests geben das Modul explizit mit.
 */
import type { Repositories } from "@quizmaster/db";
import { fromLobbySnapshot, type RestoreReset } from "@quizmaster/game-engine";
import { type GameTimingMode, socketClientOptions } from "@quizmaster/shared";
import type { LobbyDoc } from "@quizmaster/shared/documents";
import { type GameRuntime, gameRuntimeOf } from "../lobby/module.ts";
import type { Logger } from "../logger.ts";
import type { RealtimeMetrics, ResumeOutcome } from "../metrics.ts";
import type { Clock, RealtimeModule } from "../registry/types.ts";
import { withTimeout } from "../registry/util.ts";

/** Frist für das Laden aller aktiven Snapshots bzw. das Schließen eines Snapshots. */
export const RESUME_DB_TIMEOUT_MS = 10_000;

/**
 * Aufschub für den Beginn von Frage und Kategoriewahl: so lange braucht ein Client höchstens zum Wiederverbinden
 * (Socket.IO-Backoff bis 5 s, `socketClientOptions`). Bei `fast` (E2E) kurz.
 */
export function resumeGraceMs(timing: GameTimingMode): number {
  return timing === "fast" ? 300 : socketClientOptions().reconnectionDelayMax;
}

export interface ResumeReport {
  /** Aktive Snapshots in der Datenbank. */
  found: number;
  resumed: number;
  /** Nicht wiederherstellbar und geschlossen. */
  closed: number;
  /** Beim Übernehmen oder Schließen fehlgeschlagen. */
  failed: number;
  /** Was je wieder aufgenommener Lobby zurückgesetzt wurde. */
  resets: Partial<Record<RestoreReset, number>>;
}

export interface ResumeDeps {
  runtime: Pick<GameRuntime, "lobbies">;
  repos: Pick<Repositories, "lobbies">;
  clock: Clock;
  logger: Logger;
  metrics: Pick<RealtimeMetrics, "lobbiesResumed" | "recordMongoError">;
  timing: GameTimingMode;
  dbTimeoutMs?: number;
}

/** Nur gültige String-IDs schließen (eine kaputte `_id` aus der Datenbank nie als Filter weiterreichen). */
function lobbyIdOf(doc: unknown): string | null {
  const id = (doc as { _id?: unknown } | null)?._id;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

function codeOf(doc: unknown): string | undefined {
  const code = (doc as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code.slice(0, 16) : undefined;
}

/** Lädt alle aktiven Lobby-Snapshots und nimmt sie wieder auf (siehe Moduldoku). Wirft nie. */
export async function resumeLobbies(deps: ResumeDeps): Promise<ResumeReport> {
  const log = deps.logger.child({ component: "resume" });
  const timeoutMs = deps.dbTimeoutMs ?? RESUME_DB_TIMEOUT_MS;
  const report: ResumeReport = { found: 0, resumed: 0, closed: 0, failed: 0, resets: {} };
  const count = (outcome: ResumeOutcome) => {
    report[outcome] += 1;
    deps.metrics.lobbiesResumed.inc({ outcome });
  };

  let docs: LobbyDoc[];
  try {
    docs = await withTimeout(deps.repos.lobbies.listActive(), timeoutMs, "Lobby-Snapshots laden");
  } catch (error) {
    deps.metrics.recordMongoError("lobby_resume");
    log.error({ err: error }, "Wiederaufnahme nicht möglich – Lobby-Snapshots nicht lesbar; sie laufen per TTL aus");
    return report;
  }
  report.found = docs.length;
  if (docs.length === 0) return report;

  const closeSnapshot = async (doc: unknown, reason: string, outcome: ResumeOutcome) => {
    const lobbyId = lobbyIdOf(doc);
    if (lobbyId === null) {
      log.warn({ lobby: codeOf(doc), reason }, "Lobby-Snapshot ohne gültige ID – bleibt bis zum TTL-Ablauf");
      count("failed");
      return;
    }
    try {
      await withTimeout(deps.repos.lobbies.close(lobbyId, new Date(deps.clock.now())), timeoutMs, "Lobby schließen");
      count(outcome);
    } catch (error) {
      deps.metrics.recordMongoError("lobby_close");
      log.error({ err: error, lobby: codeOf(doc) }, "Nicht wiederherstellbare Lobby nicht geschlossen");
      count("failed");
    }
  };

  for (const doc of docs) {
    let restored: ReturnType<typeof fromLobbySnapshot>;
    try {
      restored = fromLobbySnapshot(doc, {
        now: deps.clock.now(),
        timing: deps.timing,
        graceMs: resumeGraceMs(deps.timing),
      });
    } catch (error) {
      log.error({ err: error, lobby: codeOf(doc) }, "Lobby-Snapshot nicht auswertbar – Lobby wird geschlossen");
      await closeSnapshot(doc, "Fehler beim Auswerten", "failed");
      continue;
    }
    if (!restored.ok) {
      log.warn({ lobby: codeOf(doc), reason: restored.reason }, "Lobby nicht wiederherstellbar – geschlossen");
      await closeSnapshot(doc, restored.reason, "closed");
      continue;
    }
    try {
      await deps.runtime.lobbies.adopt(restored.state);
      count("resumed");
      report.resets[restored.reset] = (report.resets[restored.reset] ?? 0) + 1;
      log.debug({ lobby: restored.state.code, phase: restored.state.phase, reset: restored.reset }, "Lobby übernommen");
    } catch (error) {
      log.error({ err: error, lobby: restored.state.code }, "Lobby nicht übernommen – wird geschlossen");
      await closeSnapshot(doc, "Übernahme fehlgeschlagen", "failed");
    }
  }
  const summary = { found: report.found, resumed: report.resumed, closed: report.closed, failed: report.failed };
  if (report.failed > 0) log.error({ ...summary, resets: report.resets }, "Lobbys nur teilweise wieder aufgenommen");
  else log.info({ ...summary, resets: report.resets }, "Lobbys wieder aufgenommen");
  return report;
}

export interface ResumeModuleOptions {
  /** Ergebnis der Wiederaufnahme (Tests, Diagnose). */
  onResumed?: (report: ResumeReport) => void;
}

/**
 * Modul „Wiederaufnahme“: muss NACH dem Lobby-Modul stehen (dessen onStart baut die Laufzeit). Wirft beim Start,
 * wenn die Lobby-Laufzeit fehlt (Modul-Reihenfolge falsch) – das ist ein Programmierfehler, kein Betriebsfall.
 */
export function createResumeModule(options: ResumeModuleOptions = {}): RealtimeModule {
  return {
    name: "resume",
    setup(context) {
      context.onStart(async () => {
        const runtime = gameRuntimeOf(context);
        if (runtime === undefined) throw new Error("Wiederaufnahme vor dem Lobby-Modul eingetragen");
        const report = await resumeLobbies({
          runtime,
          repos: context.db.repos,
          clock: context.clock,
          logger: context.logger,
          metrics: context.services.metrics,
          timing: context.env.GAME_TIMING,
        });
        options.onResumed?.(report);
      });
    },
  };
}

/** Standard-Instanz für den Prozess-Einstieg (`index.ts`). */
export const resumeModule: RealtimeModule = createResumeModule();
