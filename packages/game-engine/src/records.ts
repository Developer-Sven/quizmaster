/**
 * Daten für den Spielabschluss (docs/04 §Schemas games, §Fragenauswahl 6): das games-Dokument und die
 * Statistik-Deltas für Gäste (`stats`, `recentQuestionIds`) und Fragen (`stats.shown/correct`). Nur Server –
 * enthält guestIds. Aufgenommen werden nur aufgelöste Fragen (wie Tafel und Punkte).
 */
import type { GameDoc } from "@quizmaster/shared/documents";
import { RETENTION } from "@quizmaster/shared/documents";
import type { GameStats, GuestGameStats, QuestionGameStats } from "./effects.ts";
import { resolvedQuestions } from "./scoring.ts";
import { findPlayer, requireGame } from "./state.ts";
import type { GameResults, GameState, LobbyState } from "./types.ts";

type GameTurnDoc = GameDoc["turns"][number];

function requireFinished(state: LobbyState): { game: GameState; endedAt: number; results: GameResults } {
  const game = requireGame(state);
  if (game.endedAt === null || game.results === null) throw new Error("Spiel ist noch nicht beendet");
  return { game, endedAt: game.endedAt, results: game.results };
}

/** games-Dokument eines beendeten Spiels (Personen in Ranglistenreihenfolge, ein Eintrag pro Zug). */
export function buildGameDoc(state: LobbyState): GameDoc {
  const { game, endedAt, results } = requireFinished(state);
  const players = results.ranking.map((entry) => {
    const player = findPlayer(state, entry.playerId);
    if (!player) throw new Error(`Person ${entry.playerId} fehlt im Zustand`);
    return {
      playerId: player.playerId,
      guestId: player.guestId,
      name: player.name,
      color: player.color,
      isBot: player.isBot,
      place: entry.place,
      score: entry.score,
      status: entry.status,
    };
  });
  const turns: GameTurnDoc[] = [];
  for (const turn of game.turns) {
    const resolved = resolvedQuestions(turn);
    if (turn.categoryId === null || resolved.length === 0) continue;
    turns.push({
      round: turn.round,
      pickerId: turn.pickerId,
      offered: turn.options.map((option) => option.id),
      categoryId: turn.categoryId,
      pickedBy: turn.pickedBy ?? "timeout",
      questions: resolved.map((question) => ({
        questionId: question.questionId,
        shownOrder: [...question.shownOrder],
        answers: (question.outcomes ?? []).map((outcome) => ({
          playerId: outcome.playerId,
          choice: outcome.choice,
          ms: outcome.ms,
          correct: outcome.correct,
        })),
      })),
    });
  }
  return {
    _id: game.gameId,
    lobbyId: state.lobbyId,
    code: state.code,
    startedAt: new Date(game.startedAt),
    endedAt: new Date(endedAt),
    expiresAt: new Date(endedAt + RETENTION.gameMs),
    settings: { ...state.settings },
    outcome: results.outcome,
    players,
    turns,
  };
}

/** Statistik-Deltas eines beendeten Spiels (nur Menschen; Bots verfälschen keine Fragen-Statistik). */
export function buildGameStats(state: LobbyState): GameStats {
  const { game, results } = requireFinished(state);
  const humans = new Set(state.players.filter((player) => !player.isBot).map((player) => player.playerId));
  const questions: QuestionGameStats[] = [];
  const perPlayer = new Map<string, { answers: number; correct: number; questionIds: string[] }>();
  for (const turn of game.turns) {
    for (const question of resolvedQuestions(turn)) {
      let shown = 0;
      let correct = 0;
      for (const outcome of question.outcomes ?? []) {
        if (!humans.has(outcome.playerId)) continue;
        shown++;
        if (outcome.correct) correct++;
        const entry = perPlayer.get(outcome.playerId) ?? { answers: 0, correct: 0, questionIds: [] };
        entry.answers++;
        if (outcome.correct) entry.correct++;
        entry.questionIds.push(question.questionId);
        perPlayer.set(outcome.playerId, entry);
      }
      if (shown > 0) questions.push({ questionId: question.questionId, shown, correct });
    }
  }
  const guests: GuestGameStats[] = [];
  for (const entry of results.ranking) {
    const player = findPlayer(state, entry.playerId);
    if (!player || player.isBot) continue;
    const stats = perPlayer.get(entry.playerId) ?? { answers: 0, correct: 0, questionIds: [] };
    const active = entry.status === "active";
    guests.push({
      guestId: player.guestId,
      won: active && entry.place === 1 && results.outcome === "win",
      draw: active && results.outcome === "draw",
      answers: stats.answers,
      correct: stats.correct,
      questionIds: stats.questionIds,
    });
  }
  return { guests, questions };
}
