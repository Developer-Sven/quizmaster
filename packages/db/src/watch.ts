/**
 * `watchWithResume()` – gemeinsamer Change-Stream-Helfer der Realtime-Watcher (docs/04
 * §Change-Stream-Watcher): `$match` auf die relevanten `operationType`s, `fullDocument: "updateLookup"`,
 * Resume-Token im Speicher, Neustart mit exponentiellem Backoff, ungültiger/verlorener Token oder
 * invalidierter Stream → `onReset` (Vollreload beim Aufrufer), sauberes `close()`.
 *
 * Zustellung „mindestens einmal“: Der Token rückt erst NACH erfolgreichem `onChange` vor. Wirft
 * `onChange`, wird ab dem letzten verarbeiteten Token neu geöffnet (dieselbe Änderung kommt erneut);
 * nach `maxDeliveryAttempts` Fehlversuchen wird sie übersprungen und `onReset` ausgelöst, damit eine
 * einzelne „giftige“ Änderung nie alle weiteren (z. B. Bans) blockiert.
 *
 * Reihenfolge für Aufrufer: erst `watchWithResume()`, dann `await handle.ready`, DANACH den
 * Anfangsbestand laden – so geht zwischen Laden und Beobachten keine Änderung verloren. `onReset` wird
 * aus demselben Grund erst aufgerufen, wenn der neue Stream bereits offen ist.
 */

import { isDeepStrictEqual } from "node:util";
import {
  type ChangeStream,
  type ChangeStreamDocument,
  type ChangeStreamOptions,
  type Collection,
  type Document,
  MongoCursorExhaustedError,
  MongoServerError,
  type ResumeToken,
} from "mongodb";
import { MONGO_ERROR_CODES, mongoErrorCode } from "./errors.ts";
import { type DbLogger, describeError, silentLogger } from "./logger.ts";

export const WATCH_OPERATION_TYPES = ["insert", "update", "replace", "delete"] as const;
export type WatchOperationType = (typeof WATCH_OPERATION_TYPES)[number];

/** Warum der Aufrufer seinen Zustand komplett neu laden muss. */
export type WatchResetReason =
  /** Resume-Token ungültig bzw. aus dem Oplog gefallen – Änderungen können fehlen. */
  | "resume_failed"
  /** Collection gelöscht/umbenannt (`invalidate`). */
  | "invalidated"
  /** Eine Änderung ließ sich wiederholt nicht verarbeiten und wurde übersprungen. */
  | "handler_failed";

/** Nur die Ereignisarten, die der Helfer ausliefert. */
export type WatchedChange<TSchema extends Document> = Extract<
  ChangeStreamDocument<TSchema>,
  { operationType: WatchOperationType }
>;

export interface WatchHandlers<TSchema extends Document> {
  /** Eine Änderung (nacheinander, nie parallel). Muss idempotent sein. */
  onChange(change: WatchedChange<TSchema>): void | Promise<void>;
  /** Vollreload nötig; wird aufgerufen, sobald der neue Stream (ohne Token, ab „jetzt“) offen ist. */
  onReset?(reason: WatchResetReason): void | Promise<void>;
  /** Fehler mit anschließendem Neustart nach `delayMs` (nur Information, z. B. fürs Log). */
  onError?(error: unknown, retry: { attempt: number; delayMs: number }): void;
  /** Stream (wieder) offen; `resumed` = mit Resume-Token fortgesetzt. */
  onOpen?(info: { resumed: boolean }): void;
}

export interface WatchBackoff {
  initialMs: number;
  maxMs: number;
  factor: number;
}

export const DEFAULT_WATCH_BACKOFF: Readonly<WatchBackoff> = Object.freeze({
  initialMs: 500,
  maxMs: 30_000,
  factor: 2,
});

export interface WatchWithResumeOptions {
  /** Ausgelieferte Operationen (Standard: insert, update, replace, delete). */
  operationTypes?: readonly WatchOperationType[];
  /** Standard `updateLookup`: Updates liefern das aktuelle Dokument mit. */
  fullDocument?: "default" | "updateLookup" | "whenAvailable" | "required";
  /** Start hinter einem gespeicherten Token (sonst ab „jetzt“). */
  resumeToken?: ResumeToken;
  backoff?: Partial<WatchBackoff>;
  /** Wartezeit je getMore auf dem Server (Standard 1.000 ms) – bestimmt auch die Close-Latenz. */
  maxAwaitTimeMS?: number;
  /** Fehlversuche je Änderung, bevor sie übersprungen wird (Standard 3). */
  maxDeliveryAttempts?: number;
  logger?: DbLogger;
  /** Name für Logs (Standard: Collection-Name). */
  name?: string;
}

export interface WatchHandle {
  /**
   * Erfüllt, sobald der erste Stream serverseitig offen ist – Änderungen danach kommen sicher an.
   * Scheitert das Öffnen dauerhaft (z. B. fehlende Rechte), bleibt das Promise offen (der Helfer
   * versucht es mit Backoff weiter, `onError` meldet jeden Versuch) – beim Start mit Zeitlimit warten.
   */
  readonly ready: Promise<void>;
  /** Token der zuletzt verarbeiteten Änderung bzw. des letzten leeren Batches. */
  readonly resumeToken: ResumeToken | undefined;
  /** true nach `close()`. */
  readonly closed: boolean;
  /** Beendet den Stream und wartet, bis die Schleife sauber beendet ist. */
  close(): Promise<void>;
}

const RESET_ERROR_CODES: ReadonlySet<number> = new Set([
  MONGO_ERROR_CODES.invalidResumeToken,
  MONGO_ERROR_CODES.changeStreamFatalError,
  MONGO_ERROR_CODES.changeStreamHistoryLost,
  MONGO_ERROR_CODES.failedToParse,
  MONGO_ERROR_CODES.badValue,
]);

/** Vorübergehende Server-Zustände (Failover, Shutdown, Zeitlimit) – nie ein Token-Problem. */
const TRANSIENT_ERROR_CODES: ReadonlySet<number> = new Set([
  6, 7, 50, 89, 91, 189, 262, 9001, 10107, 11600, 11602, 13435, 13436,
]);
const TRANSIENT_LABELS = ["ResumableChangeStreamError", "RetryableError", "TransientTransactionError"];

function isTransientServerError(error: MongoServerError): boolean {
  if (typeof error.code === "number" && TRANSIENT_ERROR_CODES.has(error.code)) return true;
  return TRANSIENT_LABELS.some((label) => error.hasErrorLabel(label));
}

/**
 * true, wenn ein Fehler bedeutet: mit diesem Resume-Token geht es nicht weiter. `atOpen` = der Fehler
 * trat beim Öffnen des Streams auf – dann gilt jeder nicht-transiente Server-Fehler als unbrauchbarer
 * Token (der Server meldet kaputte Tokens z. B. als `FailedToParse` oder `Overflow`).
 */
export function isResumeTokenError(error: unknown, atOpen = false): boolean {
  const code = mongoErrorCode(error);
  if (code !== undefined && RESET_ERROR_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : "";
  if (/resume token|resume point|ChangeStreamHistoryLost/i.test(message)) return true;
  return atOpen && error instanceof MongoServerError && !isTransientServerError(error);
}

/** Wartezeit für Versuch `attempt` (1-basiert) mit ±20 % Jitter, gedeckelt auf `maxMs`. */
export function backoffDelay(attempt: number, backoff: WatchBackoff, random: () => number = Math.random): number {
  const base = Math.min(backoff.maxMs, backoff.initialMs * backoff.factor ** Math.max(0, attempt - 1));
  const jitter = 0.8 + random() * 0.4;
  return Math.round(Math.min(backoff.maxMs, base * jitter));
}

/** Baut die Pipeline: `$match` auf operationType zuerst, dann die Stufen des Aufrufers. */
export function buildWatchPipeline(
  operationTypes: readonly WatchOperationType[],
  pipeline: readonly Document[],
): Document[] {
  return [{ $match: { operationType: { $in: [...operationTypes] } } }, ...pipeline];
}

/** Fehler aus `onChange` – unterscheidet Verarbeitungs- von Stream-Fehlern. */
class HandlerError extends Error {
  readonly causeError: unknown;
  /** `_id` (Resume-Token) der fehlgeschlagenen Änderung. */
  readonly changeId: ResumeToken;

  constructor(cause: unknown, changeId: ResumeToken) {
    super(`onChange fehlgeschlagen: ${describeError(cause)}`);
    this.name = "HandlerError";
    this.causeError = cause;
    this.changeId = changeId;
  }
}

/** Fehler beim Öffnen des Streams (vor dem ersten Batch). */
class OpenError extends Error {
  readonly causeError: unknown;

  constructor(cause: unknown) {
    super(`Öffnen fehlgeschlagen: ${describeError(cause)}`);
    this.name = "OpenError";
    this.causeError = cause;
  }
}

/** Stream wurde serverseitig beendet (invalidate) – Neustart ohne Token + Vollreload. */
class StreamEndedError extends Error {
  constructor() {
    super("Change Stream wurde serverseitig beendet (invalidate)");
    this.name = "StreamEndedError";
  }
}

/**
 * Beobachtet `collection` dauerhaft. Die Pipeline des Aufrufers darf nur aus Code stammen (nie aus
 * Requests); sie wird hinter den `$match` auf die Operationen gehängt.
 */
export function watchWithResume<TSchema extends Document>(
  collection: Collection<TSchema>,
  pipeline: readonly Document[],
  handlers: WatchHandlers<TSchema>,
  options: WatchWithResumeOptions = {},
): WatchHandle {
  const logger = options.logger ?? silentLogger;
  const name = options.name ?? collection.collectionName;
  const operationTypes: readonly string[] = options.operationTypes ?? WATCH_OPERATION_TYPES;
  const fullPipeline = buildWatchPipeline(options.operationTypes ?? WATCH_OPERATION_TYPES, pipeline);
  const backoff: WatchBackoff = { ...DEFAULT_WATCH_BACKOFF, ...options.backoff };
  const maxAwaitTimeMS = options.maxAwaitTimeMS ?? 1_000;
  const maxDeliveryAttempts = options.maxDeliveryAttempts ?? 3;

  let token: ResumeToken | undefined = options.resumeToken;
  let closed = false;
  let current: ChangeStream<TSchema> | undefined;
  let wakeSleep: (() => void) | undefined;
  let pendingReset: WatchResetReason | undefined;
  /** Die zuletzt fehlgeschlagene Änderung und die Anzahl ihrer Fehlversuche. */
  let failing: { changeId: ResumeToken; attempts: number } | undefined;
  /** Fehlversuche seit dem letzten erfolgreich geöffneten Stream (steuert den Backoff). */
  let attempt = 0;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  /** Ruft einen optionalen Callback auf; Fehler darin beenden nie den Watcher. */
  const notify = (label: string, callback: () => void) => {
    try {
      callback();
    } catch (error) {
      logger.error(`watch ${name}: ${label} fehlgeschlagen: ${describeError(error)}`);
    }
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wakeSleep = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wakeSleep = done;
    });

  /** Merkt einen Vollreload vor: Token verwerfen, `onReset` folgt, sobald der neue Stream offen ist. */
  const scheduleReset = (reason: WatchResetReason) => {
    token = undefined;
    failing = undefined;
    pendingReset ??= reason;
    logger.warn(`watch ${name}: Vollreload nötig (${reason}) – Neustart ohne Resume-Token`);
  };

  const runPendingReset = async () => {
    const reason = pendingReset;
    if (reason === undefined) return;
    pendingReset = undefined;
    try {
      await handlers.onReset?.(reason);
    } catch (error) {
      logger.error(`watch ${name}: onReset (${reason}) fehlgeschlagen: ${describeError(error)}`);
    }
  };

  const openStream = (): ChangeStream<TSchema> => {
    const streamOptions: ChangeStreamOptions = {
      fullDocument: options.fullDocument ?? "updateLookup",
      maxAwaitTimeMS,
    };
    // startAfter (statt resumeAfter) funktioniert auch hinter einem invalidate-Ereignis.
    if (token !== undefined) streamOptions.startAfter = token;
    return collection.watch<TSchema, ChangeStreamDocument<TSchema>>(fullPipeline, streamOptions);
  };

  /** Liest Änderungen, bis der Stream endet oder ein Fehler auftritt. */
  const consume = async (stream: ChangeStream<TSchema>, resumed: boolean) => {
    let announced = false;
    while (!closed) {
      let change: ChangeStreamDocument<TSchema> | null;
      try {
        change = await stream.tryNext();
      } catch (error) {
        if (!announced && !closed) throw new OpenError(error);
        throw error;
      }
      if (closed) return;
      if (!announced) {
        announced = true;
        attempt = 0;
        resolveReady();
        notify("onOpen", () => handlers.onOpen?.({ resumed }));
        await runPendingReset();
      }
      if (change === null) {
        if (stream.closed) throw new StreamEndedError();
        // Leerer Batch: der Post-Batch-Token hält die Position aktuell, auch ohne passende Änderungen.
        token = stream.resumeToken ?? token;
        continue;
      }
      if (change.operationType === "invalidate") throw new StreamEndedError();
      if (!operationTypes.includes(change.operationType)) {
        token = change._id;
        continue;
      }
      try {
        await handlers.onChange(change as WatchedChange<TSchema>);
      } catch (error) {
        throw new HandlerError(error, change._id);
      }
      token = change._id;
      failing = undefined;
    }
  };

  /** Entscheidet nach einem Fehler: sofort neu (Reset) oder Backoff. Liefert die Wartezeit. */
  const handleFailure = (error: unknown, attempt: number): number | "restart" => {
    if (error instanceof StreamEndedError || error instanceof MongoCursorExhaustedError) {
      scheduleReset("invalidated");
      return "restart";
    }
    if (error instanceof HandlerError) {
      if (token === undefined) {
        logger.error(`watch ${name}: ${error.message} – ohne Resume-Token nicht wiederholbar`);
        scheduleReset("handler_failed");
        return "restart";
      }
      const repeated = failing !== undefined && isDeepStrictEqual(failing.changeId, error.changeId);
      const attempts = repeated && failing !== undefined ? failing.attempts + 1 : 1;
      failing = { changeId: error.changeId, attempts };
      if (attempts >= maxDeliveryAttempts) {
        logger.error(`watch ${name}: Änderung ${attempts}× nicht verarbeitbar – übersprungen (${error.message})`);
        scheduleReset("handler_failed");
        return "restart";
      }
    } else if (token !== undefined) {
      const atOpen = error instanceof OpenError;
      const cause = atOpen ? error.causeError : error;
      if (isResumeTokenError(cause, atOpen)) {
        logger.warn(`watch ${name}: Fortsetzen mit Resume-Token nicht möglich (${describeError(cause)})`);
        scheduleReset("resume_failed");
        return "restart";
      }
    }
    return backoffDelay(attempt, backoff);
  };

  const loop = async () => {
    while (!closed) {
      const stream = openStream();
      current = stream;
      let delayMs = 0;
      try {
        await consume(stream, token !== undefined);
      } catch (error) {
        if (closed) break;
        const decision = handleFailure(error, attempt + 1);
        if (decision !== "restart") {
          attempt += 1;
          delayMs = decision;
          const cause = error instanceof HandlerError || error instanceof OpenError ? error.causeError : error;
          logger.warn(`watch ${name}: Fehler, Neustart in ${delayMs} ms (${describeError(cause)})`);
          notify("onError", () => handlers.onError?.(cause, { attempt, delayMs }));
        }
      } finally {
        current = undefined;
        // Erst den alten Stream schließen (Server-Cursor freigeben), dann warten.
        await stream.close().catch((error: unknown) => {
          logger.warn(`watch ${name}: Schließen des Streams fehlgeschlagen: ${describeError(error)}`);
        });
      }
      if (delayMs > 0 && !closed) await sleep(delayMs);
    }
  };

  const finished = loop().catch((error: unknown) => {
    logger.error(`watch ${name}: unerwarteter Abbruch: ${describeError(error)}`);
  });

  return {
    ready,
    get resumeToken() {
      return token;
    },
    get closed() {
      return closed;
    },
    async close() {
      if (!closed) {
        closed = true;
        wakeSleep?.();
        await current?.close().catch((error: unknown) => {
          logger.warn(`watch ${name}: Schließen des Streams fehlgeschlagen: ${describeError(error)}`);
        });
        resolveReady();
      }
      await finished;
    },
  };
}
