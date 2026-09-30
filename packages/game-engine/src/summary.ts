/**
 * Zug-Ergebnis und Zwischenstände (docs/01 §Zug-Ergebnis, §Rundentafel; docs/09 §7 Overlays 7 + 8) als
 * reine Funktionen über öffentliche Daten (`BoardRow`, `PublicPlayer`) – clientfähig, ohne Geheimnisse.
 */
import type { BoardRow, PlayerStatus } from "@quizmaster/shared";
import { computeResults } from "./ranking.ts";
import type { RankingEntry } from "./types.ts";

export interface TurnSummaryEntry {
  playerId: string;
  /** Kästchen dieses Zuges (richtig/falsch/keine Antwort), eines je aufgelöster Frage. */
  results: Array<boolean | null>;
  /** Punkte dieses Zuges (+1 je richtiger Antwort). */
  points: number;
}

export interface TurnSummary {
  round: number;
  pickerId: string;
  categoryId: string;
  /** Personen nach Punkten dieses Zuges (absteigend; bei Gleichstand Reihenfolge der Tafel). */
  entries: TurnSummaryEntry[];
  /** Beste Person(en) des Zuges – leer, wenn niemand gepunktet hat. */
  bestPlayerIds: string[];
}

/** Zug-Ergebnis aus einer Tafelzeile (z. B. der letzten Zeile in Phase `turn_summary`). */
export function summarizeTurn(row: BoardRow): TurnSummary {
  const entries = Object.entries(row.results)
    .map(([playerId, results]) => ({
      playerId,
      results: [...results],
      points: results.filter((result) => result === true).length,
    }))
    .sort((a, b) => b.points - a.points);
  const best = entries[0]?.points ?? 0;
  return {
    round: row.round,
    pickerId: row.pickerId,
    categoryId: row.categoryId,
    entries,
    bestPlayerIds: best > 0 ? entries.filter((entry) => entry.points === best).map((entry) => entry.playerId) : [],
  };
}

/**
 * Stand nach Runde `round` (nur Zeilen bis einschließlich dieser Runde) – Grundlage für die
 * Platzierungswechsel (Pfeil hoch/runter) auf der Rundentafel: Stand nach Runde r mit r − 1 vergleichen.
 * Gleiche Punkte = gleicher Platz; Aufgegebene hinter allen Aktiven.
 */
export function standingsAfterRound(
  board: readonly BoardRow[],
  players: ReadonlyArray<{ id: string; status: PlayerStatus }>,
  round: number,
): RankingEntry[] {
  const points = new Map<string, number>();
  for (const row of board) {
    if (row.round > round) continue;
    for (const [playerId, results] of Object.entries(row.results)) {
      points.set(playerId, (points.get(playerId) ?? 0) + results.filter((result) => result === true).length);
    }
  }
  return computeResults(
    players.map((player) => ({ playerId: player.id, status: player.status, score: points.get(player.id) ?? 0 })),
  ).ranking;
}
