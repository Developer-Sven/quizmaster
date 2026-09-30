/**
 * Punkte und Tafel (docs/01 §Punkte & Ergebnis, ADR-017): genau 1 Punkt pro richtiger Antwort, sonst
 * nichts. Punkte werden ausschließlich aus den Ergebnissen aufgelöster Fragen abgeleitet – es gibt keinen
 * separaten Zähler, der auseinanderlaufen könnte. Die laufende Frage zählt erst ab `reveal`.
 */
import { type BoardRow, GAME_RULES } from "@quizmaster/shared";
import type { GameState, QuestionOutcome, QuestionState, TurnState } from "./types.ts";

/** Punkte je playerId aus allen aufgelösten Fragen des Spiels (ohne Spiel: leer). */
export function computeScores(game: GameState | null): Map<string, number> {
  const scores = new Map<string, number>();
  if (game === null) return scores;
  for (const turn of game.turns) {
    for (const question of turn.questions) {
      for (const outcome of question.outcomes ?? []) {
        if (outcome.correct) {
          scores.set(outcome.playerId, (scores.get(outcome.playerId) ?? 0) + GAME_RULES.pointsPerCorrectAnswer);
        }
      }
    }
  }
  return scores;
}

/**
 * Löst eine Frage für die übergebenen (aktiven) Personen auf: gewählte Position, richtig/falsch und
 * Antwortzeit. Ohne Antwort: `choice: null`, falsch.
 */
export function resolveOutcomes(question: QuestionState, participantIds: readonly string[]): QuestionOutcome[] {
  const startsAt = question.startsAt ?? 0;
  return participantIds.map((playerId) => {
    const response = question.responses.find((entry) => entry.playerId === playerId);
    if (!response) return { playerId, choice: null, correct: false, ms: null };
    return {
      playerId,
      choice: response.choice,
      correct: response.choice === question.correct,
      ms: Math.max(0, response.at - startsAt),
    };
  });
}

/** Aufgelöste Fragen eines Zuges (in Spielreihenfolge). */
export function resolvedQuestions(turn: TurnState): QuestionState[] {
  return turn.questions.filter((question) => question.outcomes !== null);
}

/**
 * Tafel: eine Zeile je Zug mit mindestens einer aufgelösten Frage; je Teilnehmer:in des Zuges ein Eintrag
 * pro aufgelöster Frage (richtig `true`, falsch `false`, keine Antwort bzw. schon aufgegeben `null`).
 */
export function buildBoard(game: GameState | null): BoardRow[] {
  if (game === null) return [];
  const rows: BoardRow[] = [];
  for (const turn of game.turns) {
    if (turn.categoryId === null) continue;
    const resolved = resolvedQuestions(turn);
    if (resolved.length === 0) continue;
    const results = Object.fromEntries(
      turn.participantIds.map((playerId) => [
        playerId,
        resolved.map((question) => {
          const outcome = question.outcomes?.find((entry) => entry.playerId === playerId);
          return outcome === undefined || outcome.choice === null ? null : outcome.correct;
        }),
      ]),
    );
    rows.push({ round: turn.round, pickerId: turn.pickerId, categoryId: turn.categoryId, results });
  }
  return rows;
}
