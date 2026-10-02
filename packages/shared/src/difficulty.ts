/**
 * Schwierigkeit im Spiel (ADR-055): Bereich „von–bis“ (Stufen 1–5), ob die Stufe pro Frage oder pro Kategorie
 * wechselt und ob sie aufsteigt oder zufällig ist. Reine Funktionen für den Server (Fragenziehung) und den Client
 * (Vorschau im Einstellungen-Sheet).
 */
import { DIFFICULTIES, type Difficulty } from "./constants.ts";

/** Die Stufe wechselt pro Frage oder pro Kategorie (dann sind alle Fragen eines Zuges gleich schwer). */
export const DIFFICULTY_BASES = ["question", "category"] as const;
export type DifficultyBasis = (typeof DIFFICULTY_BASES)[number];

/** Aufsteigend (gleichmäßig von leicht nach schwer) oder zufällig. */
export const DIFFICULTY_ORDERS = ["ascending", "random"] as const;
export type DifficultyOrder = (typeof DIFFICULTY_ORDERS)[number];

/** Schwierigkeit für einen Zug (Effect `loadQuestions`). */
export interface DifficultyRule {
  min: Difficulty;
  max: Difficulty;
  basis: DifficultyBasis;
  order: DifficultyOrder;
  /** Laufende Nummer des Zuges (1-basiert) und geplante Züge im Spiel – für „pro Kategorie, aufsteigend“ */
  turnNumber: number;
  turns: number;
}

function toDifficulty(value: number): Difficulty {
  const level = DIFFICULTIES.find((entry) => entry === value);
  if (level === undefined) throw new RangeError(`Keine Schwierigkeitsstufe: ${value}`);
  return level;
}

/** Alle Stufen von `min` bis `max`. */
export function difficultyRange(min: Difficulty, max: Difficulty): Difficulty[] {
  return DIFFICULTIES.filter((level) => level >= min && level <= max);
}

/**
 * `count` Stufen gleichmäßig von `min` bis `max`, aufsteigend – 1–3 bei 6: 1, 1, 2, 2, 3, 3; 1–5 bei 3: 1, 3, 5.
 * Bei einer einzigen die mittlere Stufe.
 */
export function spreadDifficulties(min: Difficulty, max: Difficulty, count: number): Difficulty[] {
  if (!Number.isInteger(count) || count < 1) return [];
  const span = max - min;
  if (count === 1) return [toDifficulty(min + Math.round(span / 2))];
  return Array.from({ length: count }, (_, index) => toDifficulty(min + Math.round((index * span) / (count - 1))));
}

/** Stufe eines Zuges bei „pro Kategorie, aufsteigend“: von Kategorie zu Kategorie gleichmäßig schwerer. */
export function turnDifficulty(min: Difficulty, max: Difficulty, turnNumber: number, turns: number): Difficulty {
  const total = Math.max(1, Math.trunc(turns));
  const index = Math.min(Math.max(Math.trunc(turnNumber), 1), total) - 1;
  return spreadDifficulties(min, max, total)[index] ?? min;
}
