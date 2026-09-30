/** Ergebnis-Kästchen: richtig · falsch · offen (noch nicht aufgelöst) · keine Antwort (zählt als falsch). */
export type SquareResult = "correct" | "wrong" | "open" | "none";

/** Wert aus `BoardRow.results` (docs/05): true/false/null; fehlender Eintrag = noch offen. */
export function squareResult(value: boolean | null | undefined): SquareResult {
  if (value === true) return "correct";
  if (value === false) return "wrong";
  if (value === null) return "none";
  return "open";
}
