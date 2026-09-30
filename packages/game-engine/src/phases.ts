/**
 * Phasenwechsel (docs/02 §Zustandsautomat, docs/05 §Phasen). Jede Phase bekommt ein neues `phaseToken`;
 * der Phasen-Timer trägt dasselbe Token, ältere Phasen-Timer werden entfernt.
 */
import type { Phase } from "@quizmaster/shared";
import { requestPersist, type Tx } from "./context.ts";
import { allocateToken } from "./state.ts";
import { removeTimers } from "./timers.ts";
import type { LobbyState } from "./types.ts";

export interface PhaseEnd {
  /** Öffentliches Phasenende (`phaseEndsAt`); `null` = wartet auf eine Aktion (lobby, game_over). */
  endsAt: number | null;
  /** Fälligkeit des Phasen-Timers, falls abweichend (Frage: Deadline + Kulanz). Standard: `endsAt`. */
  timerAt?: number;
}

/** Wechselt in `phase` (Beginn = `tx.now`) und plant den Phasen-Timer. */
export function enterPhase(state: LobbyState, phase: Phase, tx: Tx, end: PhaseEnd): LobbyState {
  const [withToken, token] = allocateToken(removeTimers(state, (timer) => timer.kind === "phase"));
  const timerAt = end.timerAt ?? end.endsAt;
  requestPersist(tx, "phase");
  return {
    ...withToken,
    phase,
    phaseToken: token,
    phaseStartedAt: tx.now,
    phaseEndsAt: end.endsAt,
    timers:
      timerAt === null
        ? withToken.timers
        : [...withToken.timers, { token, kind: "phase", at: timerAt, playerId: null }],
  };
}

/**
 * Verlegt das Ende der laufenden Phase (frühe Auflösung einer Frage): neues Token, gleiche Phase und
 * gleicher Phasenbeginn.
 */
export function reschedulePhaseEnd(state: LobbyState, endsAt: number, timerAt: number = endsAt): LobbyState {
  const [withToken, token] = allocateToken(removeTimers(state, (timer) => timer.kind === "phase"));
  return {
    ...withToken,
    phaseToken: token,
    phaseEndsAt: endsAt,
    timers: [...withToken.timers, { token, kind: "phase", at: timerAt, playerId: null }],
  };
}

/** Entfernt den Phasen-Timer (z. B. nach der Kategoriewahl, während Fragen geladen werden). */
export function clearPhaseTimer(state: LobbyState): LobbyState {
  return removeTimers(state, (timer) => timer.kind === "phase");
}
