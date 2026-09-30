/**
 * Arbeitskontext eines Commands. Handler sind reine Funktionen `(state, command, tx) → state`; fachliche
 * Ablehnungen werfen sie als `ProtocolError` (shared) – `reduce` fängt genau diese ab und liefert den
 * unveränderten Zustand plus Fehlercode. Alle anderen Fehler sind Programmierfehler und werden weitergeworfen.
 */
import { type ErrorCode, type GameTimingMode, getTimings, ProtocolError, type Timings } from "@quizmaster/shared";
import { type Effect, PERSIST_REASONS, type PersistReason } from "./effects.ts";
import type { Rng } from "./rng.ts";

/** Kontext je Aufruf (docs/02): Zeit nur aus `now`, Zufall nur aus `rng`. */
export interface EngineContext {
  /** Serverzeit in ms (`Date.now()` der Shell). */
  now: number;
  rng: Rng;
}

export interface Tx {
  readonly now: number;
  readonly rng: Rng;
  readonly timings: Timings;
  /** Von Handlern erzeugte Effects (kick, notice, offerCategories, loadQuestions, gameFinished, closeLobby). */
  readonly effects: Effect[];
  /** Wichtigster Snapshot-Anlass dieses Commands (höchstens ein `persist` je Command). */
  persistReason: PersistReason | null;
  /** Person, die in jedem Fall `lobby:state` + `lobby:self` bekommt (Beitritt, Wiederverbinden). */
  syncPlayerId: string | null;
}

/** Prüft `ctx.now` (ganze Zahl ≥ 0) – ein ungültiger Wert ist ein Programmierfehler der Shell. */
export function assertNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError(`ctx.now muss eine ganze Zahl ≥ 0 sein (erhalten: ${now})`);
  }
}

export function createTx(timing: GameTimingMode, now: number, rng: Rng): Tx {
  assertNow(now);
  return { now, rng, timings: getTimings(timing), effects: [], persistReason: null, syncPlayerId: null };
}

/** Fachliche Ablehnung mit Protokoll-Code (wird zum Fehler-Ack). */
export function reject(code: ErrorCode, message?: string): never {
  throw new ProtocolError(code, message);
}

/** Merkt einen Snapshot-Anlass vor; bei mehreren gewinnt der wichtigste (Reihenfolge in PERSIST_REASONS). */
export function requestPersist(tx: Tx, reason: PersistReason): void {
  const current = tx.persistReason;
  if (current === null || PERSIST_REASONS.indexOf(reason) < PERSIST_REASONS.indexOf(current)) {
    tx.persistReason = reason;
  }
}
