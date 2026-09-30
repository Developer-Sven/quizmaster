/**
 * Antwortreihenfolge (docs/01 §Fragen, docs/05 §Fairness, docs/06 Invariante 2): Konvention im Katalog
 * ist `answers[0]` = richtig (ADR-007) – der Server mischt daher jede Frage gleichverteilt mit dem
 * übergebenen RNG (Produktion: `crypto.randomInt`). Ausnahme `displayOrder: "asc"`: Zahlen/Jahreszahlen
 * aufsteigend nach Zahlenwert; gleiche Werte bleiben in zufälliger Reihenfolge (nie die Repo-Reihenfolge).
 */
import type { AnswerIndex } from "@quizmaster/shared";
import type { DisplayOrder } from "@quizmaster/shared/content";
import { type Rng, shuffle } from "./rng.ts";
import type { ShownAnswers, ShownOrder } from "./types.ts";

export interface ArrangedAnswers {
  /** Antworten in Anzeigereihenfolge. */
  answers: ShownAnswers;
  /** `shownOrder[i]` = Repo-Index der an Position i gezeigten Antwort. */
  shownOrder: ShownOrder;
  /** Position der richtigen Antwort (Repo-Index 0) in der Anzeige. */
  correct: AnswerIndex;
}

/**
 * Zahlenwert einer Antwort im deutschen Format: optionales Minus, Tausenderpunkte, Dezimalkomma,
 * beliebige Einheit dahinter („7.000“, „1,95583“, „35 mm“, „25 %“, „−3“). `null`, wenn keine Zahl vorne steht.
 */
export function parseDisplayNumber(text: string): number | null {
  // Vorzeichen optional mit Leerraum dahinter; linear (kein doppeltes `\s*` rund um eine optionale Gruppe).
  const match = /^\s*(?:([-−–])\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?/u.exec(text);
  if (!match) return null;
  const integer = (match[2] ?? "").replaceAll(".", "");
  const fraction = match[3] ?? "";
  const value = Number(fraction ? `${integer}.${fraction}` : integer);
  if (!Number.isFinite(value)) return null;
  return match[1] ? -value : value;
}

let collator: Intl.Collator | undefined;

function numericCollator(): Intl.Collator {
  collator ??= new Intl.Collator("de", { numeric: true, sensitivity: "base" });
  return collator;
}

/**
 * Sortiert eine (bereits gemischte) Permutation aufsteigend nach dem Zahlenwert der Antworten. Lassen sich
 * nicht alle vier Antworten als Zahl lesen, wird natürlich (numerisch-bewusst) nach Text sortiert.
 * Die Sortierung ist stabil: gleiche Werte behalten die zufällige Reihenfolge.
 */
function sortAscending(permutation: AnswerIndex[], answers: readonly string[]): AnswerIndex[] {
  const values = answers.map(parseDisplayNumber);
  if (values.every((value) => value !== null)) {
    return [...permutation].sort((a, b) => (values[a] as number) - (values[b] as number));
  }
  const compare = numericCollator().compare;
  return [...permutation].sort((a, b) => compare(answers[a] ?? "", answers[b] ?? ""));
}

/** Mischt bzw. sortiert die 4 Antworten einer Frage (Repo-Reihenfolge: `answers[0]` richtig). */
export function arrangeAnswers(
  repoAnswers: readonly [string, string, string, string],
  displayOrder: DisplayOrder,
  rng: Rng,
): ArrangedAnswers {
  const shuffled = shuffle<AnswerIndex>([0, 1, 2, 3], rng);
  const permutation = displayOrder === "asc" ? sortAscending(shuffled, repoAnswers) : shuffled;
  const [p0, p1, p2, p3] = permutation as [AnswerIndex, AnswerIndex, AnswerIndex, AnswerIndex];
  const correct = permutation.indexOf(0);
  if (correct < 0 || correct > 3) throw new Error("Mischung ohne richtige Antwort");
  return {
    answers: [repoAnswers[p0], repoAnswers[p1], repoAnswers[p2], repoAnswers[p3]],
    shownOrder: [p0, p1, p2, p3],
    correct: correct as AnswerIndex,
  };
}
