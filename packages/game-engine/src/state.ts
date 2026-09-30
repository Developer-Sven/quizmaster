/**
 * Abfragen und unveränderliche Updates des Lobby-Zustands. Updates liefern immer neue Objekte und teilen
 * unveränderte Teile (kein Mutieren – `reduce` bleibt rein, auch bei eingefrorenem Eingabezustand).
 */
import type { EnginePlayer, GameState, LobbyState, QuestionState, TurnState } from "./types.ts";

export function findPlayer(state: LobbyState, playerId: string): EnginePlayer | undefined {
  return state.players.find((player) => player.playerId === playerId);
}

export function findPlayerByGuestId(state: LobbyState, guestId: string): EnginePlayer | undefined {
  return state.players.find((player) => player.guestId === guestId);
}

/** Mitglieder (nicht verlassen/entfernt). */
export function members(state: LobbyState): EnginePlayer[] {
  return state.players.filter((player) => !player.left);
}

/** Menschliche Mitglieder. */
export function humanMembers(state: LobbyState): EnginePlayer[] {
  return state.players.filter((player) => !player.left && !player.isBot);
}

/** Verbundene Mitglieder (Bots sind immer verbunden). */
export function connectedMembers(state: LobbyState): EnginePlayer[] {
  return state.players.filter((player) => !player.left && player.connected);
}

/** Verbundene menschliche Mitglieder („jemand verbunden“ für das Schließen der Lobby). */
export function connectedHumans(state: LobbyState): EnginePlayer[] {
  return state.players.filter((player) => !player.left && !player.isBot && player.connected);
}

/** Aktive Personen im Spiel (nicht aufgegeben, nicht verlassen). */
export function activePlayers(state: LobbyState): EnginePlayer[] {
  return state.players.filter((player) => !player.left && player.status === "active");
}

export function isActive(player: EnginePlayer | undefined): player is EnginePlayer {
  return player !== undefined && !player.left && player.status === "active";
}

export function isBanned(state: LobbyState, guestId: string): boolean {
  return state.bannedGuestIds.includes(guestId);
}

export function updatePlayer(state: LobbyState, playerId: string, patch: Partial<EnginePlayer>): LobbyState {
  return {
    ...state,
    players: state.players.map((player) => (player.playerId === playerId ? { ...player, ...patch } : player)),
  };
}

export function removePlayer(state: LobbyState, playerId: string): LobbyState {
  return { ...state, players: state.players.filter((player) => player.playerId !== playerId) };
}

/** Laufendes Spiel oder Programmierfehler (nur aufrufen, wenn die Phase ein Spiel voraussetzt). */
export function requireGame(state: LobbyState): GameState {
  if (state.game === null) throw new Error(`Kein Spiel im Zustand (Phase ${state.phase})`);
  return state.game;
}

export function updateGame(state: LobbyState, update: (game: GameState) => GameState): LobbyState {
  return { ...state, game: update(requireGame(state)) };
}

/** Aktueller (zuletzt begonnener) Zug. */
export function currentTurn(game: GameState | null): TurnState | undefined {
  return game?.turns.at(-1);
}

/** Aktuell gestellte Frage des aktuellen Zuges. */
export function currentQuestion(game: GameState | null): QuestionState | undefined {
  const turn = currentTurn(game);
  return turn && turn.currentIndex >= 0 ? turn.questions[turn.currentIndex] : undefined;
}

export function updateCurrentTurn(state: LobbyState, update: (turn: TurnState) => TurnState): LobbyState {
  return updateGame(state, (game) => {
    const turn = currentTurn(game);
    if (!turn) throw new Error("Kein aktueller Zug");
    return { ...game, turns: [...game.turns.slice(0, -1), update(turn)] };
  });
}

export function updateCurrentQuestion(
  state: LobbyState,
  update: (question: QuestionState) => QuestionState,
): LobbyState {
  return updateCurrentTurn(state, (turn) => {
    const question = turn.questions[turn.currentIndex];
    if (!question) throw new Error("Keine gestellte Frage im aktuellen Zug");
    return {
      ...turn,
      questions: turn.questions.map((item, index) => (index === turn.currentIndex ? update(item) : item)),
    };
  });
}

/** Vergibt das nächste Token (Timer, Anfragen, Phasen). */
export function allocateToken(state: LobbyState): [LobbyState, number] {
  const token = state.seq + 1;
  return [{ ...state, seq: token }, token];
}

/** Alle Fragen des Spiels (chronologisch). */
export function allQuestions(game: GameState): QuestionState[] {
  return game.turns.flatMap((turn) => turn.questions);
}

/** DB-IDs aller Fragen, die in diesem Spiel schon gezogen wurden (nie doppelt). */
export function usedQuestionIds(game: GameState): string[] {
  return allQuestions(game).map((question) => question.questionId);
}
