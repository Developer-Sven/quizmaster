/**
 * Daten der Tafel (Board, docs/09 §7.8): Zeilen bis zu einer Runde und Personen mit Summe, Status und Platzwechsel.
 * Reine Funktionen – genutzt von Rundentafel, Spielende und der Karte „Letztes Spiel“ in der Lobby (ADR-038).
 */
import type { BoardRow, PublicPlayer } from "@quizmaster/shared";
import { type CategoryCatalog, categoryVisual, pointsUntilRound, rankChanges } from "../../lib/client/game-view";
import type { BoardPlayer, BoardRowData } from "../ui/board";

/** Tafelzeilen bis einschließlich Runde `round` mit Kategorie-Darstellung. */
export function boardRowsUntil(board: readonly BoardRow[], round: number, categories: CategoryCatalog): BoardRowData[] {
  return board
    .filter((row) => row.round <= round)
    .map((row, position) => ({
      key: `${row.round}-${row.pickerId}-${position}`,
      category: categoryVisual(categories, row.categoryId),
      results: row.results,
    }));
}

/** Personen der Tafel mit Summe, Status und Platzwechsel (Pfeil hoch/runter) nach Runde `round`. */
export function boardPlayers(
  board: readonly BoardRow[],
  participants: readonly PublicPlayer[],
  round: number,
): BoardPlayer[] {
  const points = pointsUntilRound(board, round);
  const changes = rankChanges(board, participants, round);
  return participants.map((player) => ({
    id: player.id,
    name: player.name,
    color: player.color,
    score: points.get(player.id) ?? 0,
    resigned: player.status === "resigned",
    rankChange: changes[player.id] ?? null,
  }));
}
