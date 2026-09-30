/**
 * Fragenzahl und Dauer-Schätzung für die Lobby-Zusammenfassung (docs/01 §Einstellungen, docs/09 §11),
 * z. B. „36 Fragen · ca. 12 Min.“.
 *
 * Rundungsregel: Minuten = Sekunden / 60, kaufmännisch gerundet (`Math.round`, ab ,5 aufwärts),
 * mindestens 1 Minute. Beispiele: 3 Runden × 4 Personen × 3 Fragen = 706 s → 11,77 → „ca. 12 Min.“;
 * 3 × 3 × 3 = 535 s → 8,92 → „ca. 9 Min.“.
 */

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

/**
 * Geschätzte Spieldauer in Sekunden: `4 + R × (P × (6 + 2 + K × 15 + 4) + 6)`
 * (Intro 4 s; je Zug Wahl ≈ 6 s, Einblendung 2 s, je Frage ≈ 15 s, Zug-Ergebnis 4 s; je Runde Tafel 6 s).
 */
export function estimateDurationSeconds(rounds: number, players: number, questionsPerCategory: number): number {
  assertCount("rounds", rounds);
  assertCount("players", players);
  assertCount("questionsPerCategory", questionsPerCategory);
  return 4 + rounds * (players * (6 + 2 + questionsPerCategory * 15 + 4) + 6);
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
export function formatGameEstimate(rounds: number, players: number, questionsPerCategory: number): string {
  const count = questionCount(rounds, players, questionsPerCategory);
  const seconds = estimateDurationSeconds(rounds, players, questionsPerCategory);
  return `${count} ${count === 1 ? "Frage" : "Fragen"} · ${formatDurationEstimate(seconds)}`;
}
