/**
 * Fragenzahl und Dauer-Schätzung für die Lobby-Zusammenfassung (docs/01 §Einstellungen, docs/09 §11),
 * z. B. „36 Fragen · ca. 12 Min.“.
 *
 * Rundungsregel: Minuten = Sekunden / 60, kaufmännisch gerundet (`Math.round`, ab ,5 aufwärts),
 * mindestens 1 Minute. Beispiele: 3 Runden × 4 Personen × 3 Fragen = 806 s → 13,43 → „ca. 13 Min.“;
 * 3 × 3 × 3 = 611 s → 10,18 → „ca. 10 Min.“.
 */

import { ADVANCE_DEFAULTS, type AdvanceSettings, GAME_RULES, type LobbySettings, MANUAL_ADVANCE } from "./settings.ts";

function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} muss eine ganze Zahl ≥ 0 sein (erhalten: ${value})`);
  }
}

/** Gesamtzahl Fragen = Runden × Personen × Fragen pro Kategorie. */
export function questionCount(rounds: number, players: number, questionsPerCategory: number): number {
  assertCount("rounds", rounds);
  assertCount("players", players);
  assertCount("questionsPerCategory", questionsPerCategory);
  return rounds * players * questionsPerCategory;
}

/** Eingestellte Sekunden oder – bei „Host tippt Weiter“ bzw. ohne Angabe – der Standard. */
function advanceSec(value: number | undefined, fallback: number): number {
  return value === undefined || value === MANUAL_ADVANCE ? fallback : value;
}

/**
 * Geschätzte Spieldauer in Sekunden: `5 + R × (P × (6 + 3 + K × (1 + A + F) + Z) + T)` mit A = im Schnitt
 * benötigte Antwortzeit (gut die Hälfte der Zeit pro Frage: 20 s → 11 s, ADR-049) und F/Z/T = Sekunden nach jeder
 * Frage, Kategorie und Runde (ADR-045; Standard 5/5/7 – Spieltempo ADR-044: Intro 5 s, je Zug Wahl ≈ 6 s,
 * Einblendung 3 s, 1 s Vorlauf je Frage). „Host“ zählt jeweils wie der Standard.
 */
export function estimateDurationSeconds(
  rounds: number,
  players: number,
  questionsPerCategory: number,
  advance: Partial<AdvanceSettings & Pick<LobbySettings, "answerSec">> = {},
): number {
  assertCount("rounds", rounds);
  assertCount("players", players);
  assertCount("questionsPerCategory", questionsPerCategory);
  const afterQuestion = advanceSec(advance.afterQuestionSec, ADVANCE_DEFAULTS.afterQuestionSec);
  const afterTurn = advanceSec(advance.afterTurnSec, ADVANCE_DEFAULTS.afterTurnSec);
  const afterRound = advanceSec(advance.afterRoundSec, ADVANCE_DEFAULTS.afterRoundSec);
  const answering = Math.round(advanceSec(advance.answerSec, GAME_RULES.answerTimeMs / 1_000) * 0.55);
  return (
    5 + rounds * (players * (6 + 3 + questionsPerCategory * (1 + answering + afterQuestion) + afterTurn) + afterRound)
  );
}

/** Sekunden → ganze Minuten nach der Rundungsregel oben (mindestens 1). */
export function roundDurationMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/** „ca. 12 Min.“ */
export function formatDurationEstimate(seconds: number): string {
  return `ca. ${roundDurationMinutes(seconds)} Min.`;
}

/** „36 Fragen · ca. 12 Min.“ (bei genau einer Frage „1 Frage · …“). */
export function formatGameEstimate(
  rounds: number,
  players: number,
  questionsPerCategory: number,
  advance: Partial<AdvanceSettings & Pick<LobbySettings, "answerSec">> = {},
): string {
  const count = questionCount(rounds, players, questionsPerCategory);
  const seconds = estimateDurationSeconds(rounds, players, questionsPerCategory, advance);
  return `${count} ${count === 1 ? "Frage" : "Fragen"} · ${formatDurationEstimate(seconds)}`;
}
