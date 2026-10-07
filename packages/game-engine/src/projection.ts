/**
 * Projektion (docs/02 §Engine-Muster, docs/05 §Zustände, docs/06 Invarianten 1 + 4): Nur diese Funktionen
 * erzeugen Payloads für Clients – nie den rohen Zustand senden. Vor `reveal` enthält kein Payload
 * `correct`, `picks`, `explanation` oder `source`; Punkte und Tafel enthalten nur aufgelöste Fragen; die
 * guestId erscheint nie. Rückgaben sind frische Objekte (keine Referenzen in den Engine-Zustand).
 */
import {
  hasCategoryPick,
  PROTOCOL_VERSION,
  type PrivatePlayerState,
  type PublicLobbyState,
  type PublicPlayer,
  type PublicQuestion,
  type SettingsChanges,
} from "@quizmaster/shared";
import { buildBoard, computeScores } from "./scoring.ts";
import { activePlayers, currentQuestion, currentTurn, findPlayer, isActive } from "./state.ts";
import { type GameState, isRunningPhase, type LobbyState } from "./types.ts";

type Progress = NonNullable<PublicLobbyState["progress"]>;
type PublicTurn = NonNullable<PublicLobbyState["turn"]>;

/** Phasen, in denen der aktuelle Zug öffentlich ist. */
const TURN_PHASES = new Set(["category_pick", "question", "reveal", "turn_summary"]);

/** Aktive Personen, die in dieser Runde nach `game.orderIndex` noch wählen. */
export function remainingPickers(state: LobbyState, game: GameState): string[] {
  const active = new Set(activePlayers(state).map((player) => player.playerId));
  return game.order.filter((playerId, index) => index > game.orderIndex && active.has(playerId));
}

function projectProgress(state: LobbyState): Progress | null {
  const game = state.game;
  if (game === null || !isRunningPhase(state.phase)) return null;
  // Ohne Wahl ist eine Runde genau ein Zug (ADR-056).
  if (!hasCategoryPick(state.settings)) {
    return { round: game.round, rounds: state.settings.rounds, turn: 1, turnsPerRound: 1 };
  }
  const turnsInRound = game.turns.filter((turn) => turn.round === game.round).length;
  const turn = Math.max(1, turnsInRound);
  return {
    round: game.round,
    rounds: state.settings.rounds,
    turn,
    turnsPerRound: Math.max(turn, turnsInRound + remainingPickers(state, game).length),
  };
}

function projectTurn(state: LobbyState): PublicTurn | null {
  if (!TURN_PHASES.has(state.phase)) return null;
  const turn = currentTurn(state.game);
  if (!turn) return null;
  return {
    pickerId: turn.pickerId,
    options: turn.options.map((option) => ({ ...option })),
    categoryId: turn.categoryId,
  };
}

function projectQuestion(state: LobbyState): PublicQuestion | null {
  if (state.phase !== "question" && state.phase !== "reveal") return null;
  const turn = currentTurn(state.game);
  const question = currentQuestion(state.game);
  if (!turn || !question || question.startsAt === null || question.deadline === null) return null;
  const active = new Set(activePlayers(state).map((player) => player.playerId));
  const base: PublicQuestion = {
    id: question.instanceId,
    index: turn.currentIndex + 1,
    total: turn.questions.length,
    categoryId: question.categoryId,
    prompt: question.prompt,
    answers: [...question.answers],
    media: question.media ? { ...question.media } : null,
    startsAt: question.startsAt,
    deadline: question.deadline,
    answeredBy: question.responses.filter((entry) => active.has(entry.playerId)).map((entry) => entry.playerId),
  };
  // Geheimnisse erst ab der Auflösung (docs/06 Invariante 1).
  if (state.phase !== "reveal" || question.outcomes === null) return base;
  return {
    ...base,
    correct: question.correct,
    picks: Object.fromEntries(question.outcomes.map((outcome) => [outcome.playerId, outcome.choice])),
    explanation: question.explanation,
  };
}

/** Öffentlicher Snapshot für den Lobby-Raum (Event `lobby:state`). */
export function toPublicState(state: LobbyState): PublicLobbyState {
  const game = state.game;
  const scores = computeScores(game);
  const players: PublicPlayer[] = state.players.map((player) => ({
    id: player.playerId,
    name: player.name,
    color: player.color,
    isHost: player.playerId === state.hostPlayerId,
    isBot: player.isBot,
    connected: player.connected,
    status: player.status,
    score: scores.get(player.playerId) ?? 0,
  }));
  const results = state.phase === "game_over" ? (game?.results ?? null) : null;
  return {
    rev: state.rev,
    protocolVersion: PROTOCOL_VERSION,
    code: state.code,
    phase: state.phase,
    phaseStartedAt: state.phaseStartedAt,
    phaseEndsAt: state.phaseEndsAt,
    settings: { ...state.settings },
    players,
    order: game ? [...game.order] : null,
    progress: projectProgress(state),
    turn: projectTurn(state),
    question: projectQuestion(state),
    board: buildBoard(game),
    results: results ? { ranking: results.ranking.map((entry) => ({ ...entry })), outcome: results.outcome } : null,
    frozen: state.frozen !== null,
    suggestions: state.suggestions.map((entry) => ({
      id: entry.id,
      playerId: entry.playerId,
      changes: copyChanges(entry.changes),
      status: entry.status,
      at: entry.at,
    })),
  };
}

/** Kopie vorgeschlagener Änderungen samt Kategorie-Liste – die Projektion teilt keine Arrays mit dem Zustand. */
function copyChanges(changes: SettingsChanges): SettingsChanges {
  return changes.categoryIds ? { ...changes, categoryIds: [...changes.categoryIds] } : { ...changes };
}

/**
 * Privater Zustand einer Person (Event `lobby:self`). Wirft bei unbekannter playerId (Programmierfehler
 * der Shell – `sendPrivate` nennt nur existierende Personen).
 */
export function toPrivateState(state: LobbyState, playerId: string): PrivatePlayerState {
  const player = findPlayer(state, playerId);
  if (!player) throw new RangeError(`Unbekannte playerId: ${playerId}`);
  const turn = currentTurn(state.game);
  const canPick =
    state.phase === "category_pick" && isActive(player) && turn?.pickerId === playerId && turn.categoryId === null;
  let myAnswer: PrivatePlayerState["myAnswer"] = null;
  if (state.phase === "question" || state.phase === "reveal") {
    const question = currentQuestion(state.game);
    const response = question?.responses.find((entry) => entry.playerId === playerId);
    if (question && response) myAnswer = { questionId: question.instanceId, choice: response.choice };
  }
  return { playerId, isHost: state.hostPlayerId === playerId, canPick, myAnswer };
}
