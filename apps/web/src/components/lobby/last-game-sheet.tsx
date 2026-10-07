"use client";

import { boardPlayers, boardRowsUntil } from "@/components/game/board-data";
import { rankingEntries, resultHeadline } from "@/components/game/results";
import { Board } from "@/components/ui/board";
import { RankingList } from "@/components/ui/ranking-list";
import { Sheet } from "@/components/ui/sheet";
import { de } from "@/i18n/de";
import { type CategoryCatalog, gameParticipants } from "@/lib/client/game-view";
import type { LastGameSnapshot } from "@/lib/client/last-game";

export interface LastGameSheetProps {
  open: boolean;
  lastGame: LastGameSnapshot;
  categories: CategoryCatalog;
  onClose: () => void;
}

/**
 * Ergebnis des letzten Spiels in der Lobby (ADR-038): eigene Überschrift wie am Spielende, Rangliste aller
 * Personen des Spiels (auch Aufgegebene) und der Spielverlauf als Tafel – ohne Choreografie, als Sheet.
 */
export function LastGameSheet({ open, lastGame, categories, onClose }: LastGameSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={de.result.title}>
      <LastGameResult lastGame={lastGame} categories={categories} />
    </Sheet>
  );
}

/** Inhalt des Sheets „Ergebnis“ – ohne Ergebnis (älterer Schnappschuss) leer. */
export function LastGameResult({ lastGame, categories }: Pick<LastGameSheetProps, "lastGame" | "categories">) {
  const { state, selfId } = lastGame;
  const results = state.results;
  if (!results) return null;
  const participants = gameParticipants(state);
  const lastRound = state.board.reduce((max, row) => Math.max(max, row.round), 0);
  return (
    <div data-testid="last-game-result" className="flex flex-col gap-6 pb-4">
      {/* Unter dem Sheet-Titel (h2, 22 px) nicht größer als dieser: `title` (20 px) */}
      <p className="text-title text-text">{resultHeadline(results, participants, selfId)}</p>
      <RankingList entries={rankingEntries(results, participants)} />
      {state.board.length > 0 ? (
        <Board
          players={boardPlayers(state.board, participants, lastRound).map((player) => ({
            ...player,
            rankChange: null,
          }))}
          rows={boardRowsUntil(state.board, lastRound, categories)}
          questionsPerTurn={state.settings.questionsPerCategory}
          label={de.result.history}
        />
      ) : null}
    </div>
  );
}
