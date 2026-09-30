/**
 * Rangliste und Ausgang (docs/01 §Punkte & Ergebnis): gleiche Punkte = gleicher Platz (1, 1, 3 …),
 * „Aufgegeben“ hinter allen, die bis zum Ende gespielt haben; Ausgang „draw“, wenn alle Aktiven gleichauf
 * sind (bei 2 Personen: Unentschieden), sonst „win“.
 */
import type { GameOutcome, PlayerStatus } from "@quizmaster/shared";
import type { GameResults, RankingEntry } from "./types.ts";

export interface RankingInput {
  playerId: string;
  status: PlayerStatus;
  score: number;
}

/** Plätze nach Punkten (absteigend, gleiche Punkte = gleicher Platz), beginnend bei `firstPlace`. */
function placeGroup(entries: readonly RankingInput[], firstPlace: number): RankingEntry[] {
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const ranked: RankingEntry[] = [];
  sorted.forEach((entry, index) => {
    const previous = ranked[index - 1];
    const place = previous !== undefined && previous.score === entry.score ? previous.place : firstPlace + index;
    ranked.push({ playerId: entry.playerId, place, score: entry.score, status: entry.status });
  });
  return ranked;
}

/** Ausgang: „draw“ = alle Aktiven gleichauf (auch ohne Aktive), sonst „win“. */
export function computeOutcome(entries: readonly RankingInput[]): GameOutcome {
  const active = entries.filter((entry) => entry.status === "active");
  if (active.length === 1) return "win";
  return active.every((entry) => entry.score === active[0]?.score) ? "draw" : "win";
}

/**
 * Rangliste in Anzeigereihenfolge. Die Eingabereihenfolge (z. B. Spielreihenfolge) entscheidet bei
 * gleichem Platz über die Position in der Liste (stabile Sortierung).
 */
export function computeResults(entries: readonly RankingInput[]): GameResults {
  const active = entries.filter((entry) => entry.status === "active");
  const resigned = entries.filter((entry) => entry.status === "resigned");
  return {
    ranking: [...placeGroup(active, 1), ...placeGroup(resigned, active.length + 1)],
    outcome: computeOutcome(entries),
  };
}
