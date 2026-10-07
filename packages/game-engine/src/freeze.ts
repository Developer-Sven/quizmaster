/**
 * Netzaussetzer (ADR-057): Hört die Shell von keiner aktiven Person einer Lobby mehr etwas (der Server oder alle
 * Geräte sind kurz offline), friert sie das Spiel ein – die Spielzeit steht, der Phasen-Timer ist angehalten. Beim
 * Auftauen rücken Phasenbeginn und -ende, Fragebeginn und Antwortschluss sowie der Phasen-Timer um die Pause nach
 * hinten: Das Spiel läuft genau dort weiter, wo es stand – niemand verliert eine Frage an die Leitung.
 * Reconnect-Fristen laufen weiter (wer endgültig weg ist, scheidet wie gewohnt aus).
 */
import type { FreezeCommand } from "./commands.ts";
import type { Tx } from "./context.ts";
import { clearPhaseTimer } from "./phases.ts";
import { allocateToken, currentQuestion, updateCurrentQuestion } from "./state.ts";
import { isRunningPhase, type LobbyState } from "./types.ts";

export function onFreeze(state: LobbyState, command: FreezeCommand, tx: Tx): LobbyState {
  if (state.frozen !== null || state.game === null || !isRunningPhase(state.phase)) return state;
  const phaseTimer = state.timers.find((timer) => timer.kind === "phase");
  // Rückwirkend ab dem letzten Lebenszeichen, aber nie vor die laufende Phase (eine frühere ist schon vorbei).
  const since = Math.min(tx.now, Math.max(state.phaseStartedAt, command.since ?? tx.now));
  return { ...clearPhaseTimer(state), frozen: { since, phaseTimerAt: phaseTimer?.at ?? null } };
}

export function onThaw(state: LobbyState, tx: Tx): LobbyState {
  const frozen = state.frozen;
  if (frozen === null) return state;
  let next: LobbyState = { ...state, frozen: null };
  if (next.game === null || !isRunningPhase(next.phase)) return next;
  const pausedMs = Math.max(0, tx.now - frozen.since);
  if (next.phase === "question" && currentQuestion(next.game)?.startsAt != null) {
    next = updateCurrentQuestion(next, (question) => ({
      ...question,
      startsAt: question.startsAt === null ? null : question.startsAt + pausedMs,
      deadline: question.deadline === null ? null : question.deadline + pausedMs,
    }));
  }
  next = {
    ...next,
    phaseStartedAt: next.phaseStartedAt + pausedMs,
    phaseEndsAt: next.phaseEndsAt === null ? null : next.phaseEndsAt + pausedMs,
  };
  if (frozen.phaseTimerAt === null) return next;
  // Neues Token: ein alter TIMEOUT des angehaltenen Timers kann nicht mehr greifen.
  const [withToken, token] = allocateToken(next);
  return {
    ...withToken,
    phaseToken: token,
    timers: [...withToken.timers, { token, kind: "phase", at: frozen.phaseTimerAt + pausedMs, playerId: null }],
  };
}
