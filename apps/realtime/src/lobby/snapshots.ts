/**
 * Lobby-Snapshots (docs/04 lobbies, docs/07 „DB nur bei Phasenwechseln, gebündelt/debounced“): Der Effect
 * `persist` markiert die Lobby als geändert; spätestens `SNAPSHOT_DEBOUNCE_MS` danach wird der dann AKTUELLE
 * Zustand (`toLobbySnapshot`) per `lobbies.save` geschrieben – alle Änderungen innerhalb der Frist ergeben
 * einen einzigen Schreibvorgang (die Frist verlängert sich nicht, der Snapshot hinkt also höchstens so weit
 * hinterher). Je Lobby läuft höchstens ein Schreibvorgang gleichzeitig; `save` schreibt ohnehin nie einen
 * älteren `rev` über einen neueren und nie einen aktiven Stand über eine geschlossene Lobby.
 *
 * Fehlschläge (Datenbank weg, Zeitüberschreitung) werden gezählt, geloggt und mit Pause wiederholt, solange
 * kein neuerer Stand geschrieben wurde. `flush()` schreibt sofort (Schließen, Shutdown) und wirft nie.
 */
import type { LobbySaveResult } from "@quizmaster/db";
import type { LobbyDoc } from "@quizmaster/shared/documents";
import type { Logger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import { withTimeout } from "../registry/util.ts";

/** Entprellung der Snapshots (höchstens so lange hinkt der gespeicherte Stand hinterher). */
export const SNAPSHOT_DEBOUNCE_MS = 500;
/** Frist eines Schreibvorgangs. */
export const SNAPSHOT_WRITE_TIMEOUT_MS = 5_000;
/** Pausen vor Wiederholungen nach einem Fehlschlag (danach wartet der Writer auf die nächste Änderung). */
export const SNAPSHOT_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000];

export interface SnapshotWriterDeps {
  /** Snapshot des aktuellen Zustands (zum Zeitpunkt des Schreibens gebildet). */
  snapshot(): LobbyDoc;
  save(doc: LobbyDoc): Promise<LobbySaveResult>;
  logger: Logger;
  metrics: RealtimeMetrics;
  debounceMs?: number;
  writeTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

export interface SnapshotWriter {
  /** Änderung vormerken; geschrieben wird entprellt. */
  request(): void;
  /** Sofort schreiben (auch ohne vorgemerkte Änderung) und auf das Ende warten; wirft nie. */
  flush(): Promise<void>;
  /** Keine weiteren (entprellten oder wiederholten) Schreibvorgänge planen; laufende enden normal. */
  stop(): void;
  /** Ergebnis des letzten Schreibvorgangs (`null` = noch keiner, `failed` = Fehler). */
  lastResult(): LobbySaveResult | "failed" | null;
}

export function createSnapshotWriter(deps: SnapshotWriterDeps): SnapshotWriter {
  const debounceMs = deps.debounceMs ?? SNAPSHOT_DEBOUNCE_MS;
  const writeTimeoutMs = deps.writeTimeoutMs ?? SNAPSHOT_WRITE_TIMEOUT_MS;
  const retryDelays = deps.retryDelaysMs ?? SNAPSHOT_RETRY_DELAYS_MS;
  let dirty = false;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let last: LobbySaveResult | "failed" | null = null;

  const schedule = (delayMs: number) => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void enqueueWrite();
    }, delayMs);
    timer.unref();
  };

  const writeOnce = async () => {
    if (!dirty) return;
    dirty = false;
    let doc: LobbyDoc;
    try {
      doc = deps.snapshot();
    } catch (error) {
      deps.logger.error({ err: error }, "Lobby-Snapshot nicht erzeugbar");
      last = "failed";
      return;
    }
    try {
      const result = await withTimeout(deps.save(doc), writeTimeoutMs, "Lobby-Snapshot");
      last = result;
      failures = 0;
      if (result === "code_taken") {
        deps.logger.warn({ rev: doc.rev }, "Lobby-Snapshot: Code gehört inzwischen einer anderen aktiven Lobby");
      } else if (result === "stale") {
        deps.logger.debug({ rev: doc.rev }, "Lobby-Snapshot übersprungen – in der Datenbank steht ein neuerer Stand");
      }
    } catch (error) {
      last = "failed";
      deps.metrics.recordMongoError("lobby_snapshot");
      const delay = retryDelays[failures];
      failures += 1;
      deps.logger.warn({ err: error, rev: doc.rev, retryInMs: delay ?? null }, "Lobby-Snapshot nicht gespeichert");
      // Nur wiederholen, wenn inzwischen nichts Neueres vorgemerkt ist (das schreibt ohnehin den neuesten Stand).
      dirty = true;
      if (delay !== undefined) schedule(delay);
    }
  };

  const enqueueWrite = (): Promise<void> => {
    chain = chain.then(writeOnce, writeOnce);
    return chain;
  };

  return {
    request() {
      dirty = true;
      schedule(debounceMs);
    },
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      dirty = true;
      await enqueueWrite();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    lastResult: () => last,
  };
}
