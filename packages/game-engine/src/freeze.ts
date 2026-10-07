/**
 * Netzaussetzer (ADR-057): Hört die Shell von keiner aktiven Person einer Lobby mehr etwas (der Server oder alle
 * Geräte sind kurz offline), friert sie das Spiel ein – die Spielzeit steht, der Phasen-Timer ist angehalten. Beim
 * Auftauen rücken Phasenbeginn und -ende, Fragebeginn und Antwortschluss sowie der Phasen-Timer um die Pause nach
 * hinten: Das Spiel läuft genau dort weiter, wo es stand – niemand verliert eine Frage an die Leitung.
 * Reconnect-Fristen laufen weiter (wer endgültig weg ist, scheidet wie gewohnt aus). Eingefroren löst keine Frage
 * vorzeitig auf (lifecycle.ts), und eine Phase, die im Einfrieren beginnt, steht ab ihrem Beginn ebenfalls
 * ({@link keepFrozen}). Ein Kommando einer aktiven Person taut vorher auf (reducer.ts).
 */
import type { Command, FreezeCommand } from "./commands.ts";
import type { Tx } from "./context.ts";
import { clearPhaseTimer } from "./phases.ts";
import { allocateToken, currentQuestion, findPlayerByGuestId, updateCurrentQuestion } from "./state.ts";
import { removeTimers } from "./timers.ts";
import { isRunningPhase, type LobbyState } from "./types.ts";

/** Hält die laufende Phase an: Ihr Phasen-Timer wird entfernt und beim Auftauen verschoben neu geplant. */
function freezePhase(state: LobbyState, since: number): LobbyState {
  const phaseTimer = state.timers.find((timer) => timer.kind === "phase");
  return {
    ...clearPhaseTimer(state),
    frozen: { since, phaseTimerAt: phaseTimer?.at ?? null, phaseToken: state.phaseToken },
  };
}

export function onFreeze(state: LobbyState, command: FreezeCommand, tx: Tx): LobbyState {
  if (state.frozen !== null || state.game === null || !isRunningPhase(state.phase)) return state;
  // Rückwirkend ab dem letzten Lebenszeichen, aber nie vor die laufende Phase (eine frühere ist schon vorbei).
  return freezePhase(state, Math.min(tx.now, Math.max(state.phaseStartedAt, command.since ?? tx.now)));
}

/**
 * Beginnt im Einfrieren eine neue Phase – die Shell liefert Kategorien oder Fragen, eine Person scheidet nach ihrer
 * Reconnect-Frist aus –, steht auch sie ab ihrem Beginn: Ihr Timer wird angehalten, beim Auftauen rückt sie um die
 * Zeit seit ihrem Beginn nach hinten. Sonst liefe sie ungesehen ab, und ein späteres Auftauen verschöbe sie um die
 * ganze Pause (Frage noch nicht offen, Timer längst fällig).
 */
export function keepFrozen(state: LobbyState, tx: Tx): LobbyState {
  const frozen = state.frozen;
  if (frozen === null || frozen.phaseToken === state.phaseToken || !isRunningPhase(state.phase)) return state;
  return freezePhase(state, tx.now);
}

/**
 * Ein Kommando, das von einer aktiven Person kommt (nicht von der Shell, keine Trennung, kein Bot), beweist, dass die
 * Leitung wieder steht: Es taut vorher auf – auch über einen Socket, der noch nicht an die Lobby gebunden ist.
 */
export function thawsBefore(state: LobbyState, command: Command): boolean {
  if (state.frozen === null || !("guestId" in command) || command.type === "DISCONNECT") return false;
  const player = findPlayerByGuestId(state, command.guestId);
  return player !== undefined && !player.isBot && !player.left && player.status === "active";
}

export function onThaw(state: LobbyState, tx: Tx): LobbyState {
  const frozen = state.frozen;
  if (frozen === null) return state;
  let next: LobbyState = { ...state, frozen: null };
  if (next.game === null || !isRunningPhase(next.phase)) return next;
  // Nur die angehaltene Phase rückt nach hinten (`keepFrozen` hält jede neue Phase eigens an).
  if (next.phaseToken !== frozen.phaseToken) return next;
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
  // Neues Token: ein alter TIMEOUT des angehaltenen Timers kann nicht mehr greifen; nie zwei Phasen-Timer.
  const [withToken, token] = allocateToken(removeTimers(next, (timer) => timer.kind === "phase"));
  return {
    ...withToken,
    phaseToken: token,
    timers: [...withToken.timers, { token, kind: "phase", at: frozen.phaseTimerAt + pausedMs, playerId: null }],
  };
}
