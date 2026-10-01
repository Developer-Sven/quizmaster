/**
 * Spielablauf (docs/01 §Ablauf, docs/02 §Zustandsautomat): Auslosung, Züge, Kategoriewahl, Fragen,
 * Auflösung, Zug-Ergebnis, Rundentafel, Spielende und Aufgeben. Reine Funktionen `(state, …, tx) → state`.
 *
 * Regeln: Reihenfolge wird beim Start ausgelost und gilt für alle Runden; jede aktive Person wählt genau
 * einmal pro Runde; Aufgegebene werden übersprungen; weniger als 2 Aktive → sofort `game_over`.
 */
import { GAME_RULES, questionLeadInMs } from "@quizmaster/shared";
import { requestPersist, type Tx } from "./context.ts";
import type { TurnRef } from "./effects.ts";
import { advancePhaseEnd, clearPhaseTimer, enterPhase } from "./phases.ts";
import { computeResults } from "./ranking.ts";
import { buildGameDoc, buildGameStats } from "./records.ts";
import { pickOne, randomId, shuffle } from "./rng.ts";
import { computeScores, resolveOutcomes } from "./scoring.ts";
import {
  activePlayers,
  allocateToken,
  currentQuestion,
  currentTurn,
  findPlayer,
  members,
  requireGame,
  updateCurrentQuestion,
  updateCurrentTurn,
  updateGame,
  updatePlayer,
  usedQuestionIds,
} from "./state.ts";
import { addTimer, removeTimers } from "./timers.ts";
import type { GameEndReason, GameState, LobbyState, PickedBy } from "./types.ts";

/** Startet ein Spiel (START, REMATCH): Reihenfolge auslosen, Punkte/Tafel neu, Intro. */
export function startGame(state: LobbyState, tx: Tx): LobbyState {
  const order = shuffle(
    members(state).map((player) => player.playerId),
    tx.rng,
  );
  const game: GameState = {
    gameId: randomId(tx.rng, 16),
    startedAt: tx.now,
    endedAt: null,
    endReason: null,
    order,
    round: 1,
    orderIndex: -1,
    turns: [],
    pending: null,
    results: null,
  };
  const players = state.players.map((player) => ({ ...player, status: "active" as const }));
  requestPersist(tx, "game_started");
  return enterPhase({ ...state, players, game, lastGame: null }, "intro", tx, { endsAt: tx.now + tx.timings.introMs });
}

/** Position der nächsten aktiven Person in der Reihenfolge nach `afterIndex`, sonst `null`. */
function nextPickerIndex(state: LobbyState, game: GameState, afterIndex: number): number | null {
  const active = new Set(activePlayers(state).map((player) => player.playerId));
  for (let index = afterIndex + 1; index < game.order.length; index++) {
    const playerId = game.order[index];
    if (playerId !== undefined && active.has(playerId)) return index;
  }
  return null;
}

/**
 * Höchstens so lange wartet die Engine auf die Antwort der Shell (OPTIONS_READY, QUESTIONS_READY oder
 * LOAD_FAILED) zu einer Anfrage. Danach endet das Spiel mit `load_failed` (Timer `request`) – ein
 * DB-Hänger oder eine abgelehnte Antwort ohne Korrektur blockiert die Lobby also nie dauerhaft. Unabhängig
 * vom Timing-Modus; die Shell sollte ihre DB-Aufrufe für diese Anfragen deutlich kürzer befristen.
 */
export const SHELL_REQUEST_TIMEOUT_MS = 20_000;

/** Plant die Frist der gerade gestellten Anfrage (ersetzt die Frist einer älteren Anfrage). */
function scheduleRequestTimeout(state: LobbyState, tx: Tx): LobbyState {
  const cleared = removeTimers(state, (timer) => timer.kind === "request");
  return addTimer(cleared, "request", tx.now + SHELL_REQUEST_TIMEOUT_MS);
}

/** Frist abgelaufen: Ist noch eine Anfrage offen, endet das Spiel wie bei LOAD_FAILED. */
export function onRequestTimeout(state: LobbyState, tx: Tx): LobbyState {
  if (!state.game?.pending) return state;
  return finishGame(state, "load_failed", tx);
}

/** Fordert bei der Shell 3 Kategorien für den nächsten Zug an (Effect `offerCategories`). */
function requestOptions(state: LobbyState, round: number, orderIndex: number, tx: Tx): LobbyState {
  const game = requireGame(state);
  const pickerId = game.order[orderIndex];
  if (pickerId === undefined) throw new Error(`Keine Person an Position ${orderIndex}`);
  const [next, token] = allocateToken(state);
  const turn: TurnRef = {
    gameId: game.gameId,
    round,
    turnNumber: game.turns.length + 1,
    pickerId,
    questionsPerTurn: state.settings.questionsPerCategory,
    playedCategoryIds: game.turns.flatMap((entry) => (entry.categoryId === null ? [] : [entry.categoryId])),
    usedQuestionIds: usedQuestionIds(game),
  };
  tx.effects.push({ type: "offerCategories", token, turn });
  const requested = updateGame(next, (current) => ({
    ...current,
    pending: { kind: "options", token, pickerId, round, orderIndex },
  }));
  return scheduleRequestTimeout(requested, tx);
}

/**
 * Nächster Zug ab (`round`, `afterIndex`): nächste aktive Person → Kategorien anfordern. Gibt es in der
 * laufenden Runde niemanden mehr, folgt die Rundentafel.
 */
export function advanceFrom(state: LobbyState, round: number, afterIndex: number, tx: Tx): LobbyState {
  const cleared = updateGame(state, (game) => ({ ...game, pending: null }));
  const game = requireGame(cleared);
  const next = nextPickerIndex(cleared, game, afterIndex);
  if (next !== null) return requestOptions(cleared, round, next, tx);
  if (game.turns.some((turn) => turn.round === round)) {
    return enterPhase(cleared, "round_board", tx, {
      endsAt: advancePhaseEnd(cleared, "round_board", tx.now, tx.timings),
    });
  }
  // Eine Runde ohne einen einzigen möglichen Zug gibt es nur ohne aktive Personen.
  return finishGame(cleared, "not_enough_players", tx);
}

/** Übernimmt die Kategorie des aktuellen Zuges und fordert die Fragen an (Effect `loadQuestions`). */
export function applyPick(state: LobbyState, categoryId: string, pickedBy: PickedBy, tx: Tx): LobbyState {
  const picked = updateCurrentTurn(clearPhaseTimer(state), (turn) => ({ ...turn, categoryId, pickedBy }));
  const [next, token] = allocateToken(picked);
  const game = requireGame(next);
  tx.effects.push({
    type: "loadQuestions",
    token,
    categoryId,
    count: state.settings.questionsPerCategory,
    excludeQuestionIds: usedQuestionIds(game),
  });
  const requested = updateGame(next, (current) => ({ ...current, pending: { kind: "questions", token, categoryId } }));
  return scheduleRequestTimeout(requested, tx);
}

/** Zufall aus den drei Optionen (Zeit abgelaufen oder wählende Person hat aufgegeben). */
export function autoPick(state: LobbyState, tx: Tx): LobbyState {
  const turn = currentTurn(state.game);
  if (!turn || turn.categoryId !== null) return state;
  return applyPick(state, pickOne(turn.options, tx.rng).id, "timeout", tx);
}

/** Stellt Frage `index` des aktuellen Zuges: Vorlauf (2.000 bzw. 800 ms), dann Antwortzeit. */
export function presentQuestion(state: LobbyState, index: number, tx: Tx): LobbyState {
  const startsAt = tx.now + questionLeadInMs(tx.timings, index + 1);
  const deadline = startsAt + tx.timings.answerMs;
  const next = updateCurrentTurn(state, (turn) => {
    if (!turn.questions[index]) throw new Error(`Frage ${index} fehlt im Zug`);
    return {
      ...turn,
      currentIndex: index,
      questions: turn.questions.map((question, position) =>
        position === index ? { ...question, startsAt, deadline } : question,
      ),
    };
  });
  return enterPhase(next, "question", tx, { endsAt: deadline, timerAt: deadline + tx.timings.deadlineGraceMs });
}

/** Löst die laufende Frage auf (nur für aktive Teilnehmer:innen) → Phase `reveal`. */
export function revealCurrentQuestion(state: LobbyState, tx: Tx): LobbyState {
  const turn = currentTurn(state.game);
  if (!turn || !currentQuestion(state.game)) return state;
  const active = new Set(activePlayers(state).map((player) => player.playerId));
  const participants = turn.participantIds.filter((playerId) => active.has(playerId));
  const resolved = updateCurrentQuestion(state, (question) => ({
    ...question,
    outcomes: resolveOutcomes(question, participants),
  }));
  return enterPhase(resolved, "reveal", tx, { endsAt: advancePhaseEnd(resolved, "reveal", tx.now, tx.timings) });
}

/** Nach der Auflösung: nächste Frage des Zuges oder Zug-Ergebnis. */
function afterReveal(state: LobbyState, tx: Tx): LobbyState {
  const turn = currentTurn(state.game);
  if (turn && turn.currentIndex + 1 < turn.questions.length) return presentQuestion(state, turn.currentIndex + 1, tx);
  return enterPhase(state, "turn_summary", tx, {
    endsAt: advancePhaseEnd(state, "turn_summary", tx.now, tx.timings),
  });
}

/** Nach der Rundentafel: nächste Runde oder Spielende. */
function afterRoundBoard(state: LobbyState, tx: Tx): LobbyState {
  const game = requireGame(state);
  if (game.round < state.settings.rounds) return advanceFrom(state, game.round + 1, -1, tx);
  return finishGame(state, "completed", tx);
}

/** Phasen-Timer ist abgelaufen. */
export function onPhaseTimeout(state: LobbyState, tx: Tx): LobbyState {
  const game = state.game;
  if (game === null) return state;
  switch (state.phase) {
    case "intro":
    case "turn_summary":
      return advanceFrom(state, game.round, game.orderIndex, tx);
    case "category_pick":
      return autoPick(state, tx);
    case "question":
      return revealCurrentQuestion(state, tx);
    case "reveal":
      return afterReveal(state, tx);
    case "round_board":
      return afterRoundBoard(state, tx);
    case "game_over":
      return returnToLobby(state, tx);
    default:
      return state;
  }
}

/**
 * Nach dem Ergebnis automatisch zurück in die Lobby (ADR-038): Ausgeschiedene verlassen sie, alle anderen sind
 * wieder aktiv, die Einstellungen bleiben. Das beendete Spiel bleibt als `lastGame` für Rückblick, Bewerten und
 * Melden; ein neues Spiel startet der Host wie gewohnt aus der Lobby. Ist der Host ausgeschieden, übernimmt
 * `ensureHost` (lifecycle.ts) beim Normalisieren.
 */
export function returnToLobby(state: LobbyState, tx: Tx): LobbyState {
  const players = members(state).map((player) => ({ ...player, status: "active" as const }));
  requestPersist(tx, "players");
  return enterPhase({ ...state, players, lastGame: state.game, game: null, lastActivityAt: tx.now }, "lobby", tx, {
    endsAt: null,
  });
}

/** Beendet das Spiel mit Ergebnis (`game_over`) und liefert games-Dokument + Statistik an die Shell. */
export function finishGame(state: LobbyState, reason: GameEndReason, tx: Tx): LobbyState {
  const game = requireGame(state);
  const scores = computeScores(game);
  const results = computeResults(
    game.order.map((playerId) => ({
      playerId,
      status: findPlayer(state, playerId)?.status ?? "resigned",
      score: scores.get(playerId) ?? 0,
    })),
  );
  const ended = updateGame(state, (current) => ({
    ...current,
    endedAt: tx.now,
    endReason: reason,
    pending: null,
    results,
  }));
  // Ergebnis für `gameOverMs`, danach automatisch zurück in die Lobby (ADR-038, Timeout → returnToLobby).
  const next = enterPhase(ended, "game_over", tx, { endsAt: tx.now + tx.timings.gameOverMs });
  tx.effects.push({ type: "gameFinished", game: buildGameDoc(next), stats: buildGameStats(next) });
  requestPersist(tx, "game_over");
  return next;
}

/**
 * Person gibt im laufenden Spiel auf (verlassen, Reconnect-Frist überschritten, vom Host entfernt):
 * Status „resigned“, Punkte bleiben sichtbar, ihre Züge entfallen. Weniger als 2 Aktive → Spielende.
 */
export function resignPlayer(state: LobbyState, playerId: string, tx: Tx): LobbyState {
  const resigned = updatePlayer(state, playerId, {
    status: "resigned",
    left: true,
    connected: false,
    disconnectedAt: null,
  });
  tx.effects.push({ type: "notice", code: "PLAYER_LEFT" });
  requestPersist(tx, "players");
  if (activePlayers(resigned).length < GAME_RULES.minPlayers) return finishGame(resigned, "not_enough_players", tx);
  const game = requireGame(resigned);
  const pending = game.pending;
  // Die Shell sucht gerade Kategorien für diese Person aus → gleich die nächste Person anfragen.
  if (pending?.kind === "options" && pending.pickerId === playerId) {
    return advanceFrom(resigned, pending.round, pending.orderIndex, tx);
  }
  // Die Person wählt gerade → sofort Zufall aus den drei Optionen (niemand wartet 15 s auf sie).
  const turn = currentTurn(game);
  if (resigned.phase === "category_pick" && turn?.pickerId === playerId && turn.categoryId === null) {
    return autoPick(resigned, tx);
  }
  return resigned;
}
