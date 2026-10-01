/**
 * „Fragen ansehen“ (docs/01 §Spielende, docs/05 `game:review`) sowie die Zuordnung Instanz-ID → DB-ID für
 * `question:rate`/`question:report` („Frage wurde in diesem Spiel gezeigt“). Nur Server-seitig aufrufen;
 * `toReviewItems` liefert Geheimnisse (richtige Antwort, Erklärung) und ist daher nur nach Spielende erlaubt:
 * in `game_over` für das gerade beendete Spiel, danach in `lobby` für das zuletzt beendete (`lastGame`, ADR-038) –
 * jeweils nur für Personen, die dieses Spiel mitgespielt haben.
 */
import { ProtocolError, type RatingValue, type ReviewItem } from "@quizmaster/shared";
import { resolvedQuestions } from "./scoring.ts";
import { allQuestions, findPlayer } from "./state.ts";
import type { GameState, LobbyState } from "./types.ts";

/** Bewertungen und Meldungen der anfragenden Person, jeweils nach DB-Fragen-ID. */
export interface ReviewContext {
  ratings: ReadonlyMap<string, RatingValue>;
  reported: ReadonlySet<string>;
}

/**
 * Beendetes Spiel für Rückblick, Bewerten und Melden: in `game_over` das aktuelle, in `lobby` das zuletzt
 * beendete (`lastGame`); sonst `null` (laufendes oder kein Spiel).
 */
export function finishedGame(state: LobbyState): GameState | null {
  if (state.phase === "game_over") return state.game?.endedAt != null ? state.game : null;
  if (state.phase === "lobby") return state.lastGame ?? null;
  return null;
}

/** Hat die Person (playerId) das beendete Spiel mitgespielt? Später Beigetretene nicht. */
export function playedFinishedGame(state: LobbyState, playerId: string): boolean {
  return finishedGame(state)?.order.includes(playerId) ?? false;
}

/** Rückblick aller aufgelösten Fragen des Spiels (Reihenfolge wie gespielt, Antworten wie angezeigt). */
export function toReviewItems(state: LobbyState, playerId: string, context: ReviewContext): ReviewItem[] {
  const game = finishedGame(state);
  if (game === null) throw new ProtocolError("INVALID_PHASE", "Rückblick nur nach Spielende");
  if (!findPlayer(state, playerId)) throw new RangeError(`Unbekannte playerId: ${playerId}`);
  if (!game.order.includes(playerId)) throw new ProtocolError("INVALID_PHASE", "Rückblick nur für Mitspielende");
  return game.turns.flatMap((turn) =>
    resolvedQuestions(turn).map(
      (question): ReviewItem => ({
        questionId: question.instanceId,
        categoryId: question.categoryId,
        prompt: question.prompt,
        media: question.media ? { ...question.media } : null,
        answers: [...question.answers],
        correct: question.correct,
        explanation: question.explanation,
        picks: Object.fromEntries((question.outcomes ?? []).map((outcome) => [outcome.playerId, outcome.choice])),
        myRating: context.ratings.get(question.questionId) ?? null,
        myReported: context.reported.has(question.questionId),
      }),
    ),
  );
}

/** DB-IDs der Fragen im Rückblick (zum Laden von Bewertungen/Meldungen der Person). */
export function reviewQuestionIds(state: LobbyState): string[] {
  const game = finishedGame(state);
  if (game === null) return [];
  return game.turns.flatMap((turn) => resolvedQuestions(turn).map((question) => question.questionId));
}

/**
 * Frage-Instanz des aktuellen bzw. zuletzt beendeten Spiels, die bereits gezeigt wurde – sonst `null`
 * (Shell antwortet dann z. B. `INVALID_OPTION`). Liefert die DB-ID für Bewertung/Meldung.
 */
export function findShownQuestion(
  state: LobbyState,
  instanceId: string,
): { questionId: string; categoryId: string } | null {
  const game = state.game ?? (state.phase === "lobby" ? (state.lastGame ?? null) : null);
  if (game === null) return null;
  const question = allQuestions(game).find((entry) => entry.instanceId === instanceId && entry.startsAt !== null);
  return question ? { questionId: question.questionId, categoryId: question.categoryId } : null;
}
