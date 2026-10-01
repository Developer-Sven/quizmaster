"use client";

import type { BoardRow, PublicPlayer } from "@quizmaster/shared";
import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { Avatar } from "@/components/ui/avatar";
import { Board, type BoardPlayer, type BoardRowData, fillDelayMs } from "@/components/ui/board";
import { CategoryBadge } from "@/components/ui/category-badge";
import { ResultSquare } from "@/components/ui/result-square";
import { de } from "@/i18n/de";
import {
  type CategoryCatalog,
  categoryVisual,
  duelSides,
  firstRowOfRound,
  pointsUntilRound,
  rankChanges,
} from "@/lib/client/game-view";
import { cx } from "@/lib/ui/cx";
import { ArrowDownIcon, ArrowUpIcon } from "@/lib/ui/icons";
import { transitions } from "@/lib/ui/motion-presets";
import { squareResult } from "@/lib/ui/results";
import { OverlayFrame } from "./overlay-frame";

export interface RoundBoardOverlayProps {
  board: readonly BoardRow[];
  /** Personen des Spiels (Wahl-Reihenfolge) */
  participants: readonly PublicPlayer[];
  /** gerade beendete Runde */
  round: number;
  rounds: number;
  categories: CategoryCatalog;
  /** Fragen pro Zug (K) */
  questionsPerTurn: number;
  selfId: string | null;
}

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

/**
 * Rundentafel (Phase `round_board`, 6 s, docs/09 §7.8): „Runde 1 von 3“; 2 Personen im Duell-Layout
 * (links Person A, Mitte Kategorie, rechts Person B, oben „5 : 4“), 3–8 als `Board`-Tabelle. Die neuen
 * Zeilen der Runde füllen sich animiert; Platzwechsel mit `arrow-up`/`arrow-down` neben den Summen.
 */
export function RoundBoardOverlay({
  board,
  participants,
  round,
  rounds,
  categories,
  questionsPerTurn,
  selfId,
}: RoundBoardOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const rows = boardRowsUntil(board, round, categories);
  const players = boardPlayers(board, participants, round);
  const newFrom = firstRowOfRound(
    board.filter((row) => row.round <= round),
    round,
  );
  const sides = duelSides(participants, selfId);
  return (
    <OverlayFrame testId="overlay-round-board">
      <m.div
        initial={{ opacity: 0, y: reduce ? 0 : 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduce ? transitions.fade : transitions.enter}
        className="flex flex-col gap-4"
      >
        <h2 className="text-h2 text-text">{de.game.roundBoardTitle(round, rounds)}</h2>
        {sides ? (
          <DuelBoard
            left={players.find((player) => player.id === sides[0].id)}
            right={players.find((player) => player.id === sides[1].id)}
            rows={rows}
            newFrom={newFrom}
            questionsPerTurn={questionsPerTurn}
          />
        ) : (
          <Board players={players} rows={rows} questionsPerTurn={questionsPerTurn} animateFromRow={newFrom} />
        )}
      </m.div>
    </OverlayFrame>
  );
}

interface DuelBoardProps {
  left: BoardPlayer | undefined;
  right: BoardPlayer | undefined;
  rows: readonly BoardRowData[];
  newFrom: number;
  questionsPerTurn: number;
}

/** Kästchen je Zeile im Duell: bis 3 nebeneinander (wie die Tafel), darüber bricht es um. */
const DUEL_SQUARES_PER_LINE = 3;

function squareLines(count: number): number[][] {
  const result: number[][] = [];
  for (let start = 0; start < count; start += DUEL_SQUARES_PER_LINE) {
    result.push(Array.from({ length: Math.min(DUEL_SQUARES_PER_LINE, count - start) }, (_, offset) => start + offset));
  }
  return result;
}

function RankArrow({ change }: { change: "up" | "down" | null | undefined }) {
  if (change === "up") return <ArrowUpIcon role="img" aria-label={de.a11y.rankUp} size={16} className="text-text-2" />;
  if (change === "down") {
    return <ArrowDownIcon role="img" aria-label={de.a11y.rankDown} size={16} className="text-text-2" />;
  }
  return null;
}

/** Duell-Layout der Tafel (2 Personen, docs/01 §Rundentafel). */
function DuelBoard({ left, right, rows, newFrom, questionsPerTurn }: DuelBoardProps) {
  if (!left || !right) return null;
  const sides = [left, right] as const;
  const lines = squareLines(Math.max(1, questionsPerTurn));
  return (
    <section aria-label={de.a11y.boardCaption} className="rounded-xl border border-line bg-surface-1 p-4">
      <div className="flex items-center gap-3">
        {sides.map((player, side) => (
          <div
            key={player.id}
            className={cx("flex min-w-0 flex-1 flex-col items-center gap-1", side === 0 ? "order-1" : "order-3")}
          >
            <Avatar name={player.name} color={player.color} size={56} resigned={player.resigned} />
            <span className="max-w-full truncate text-label text-text">{player.name}</span>
          </div>
        ))}
        <p className="order-2 flex shrink-0 items-center gap-1 text-h1 text-text tabular-nums">
          <RankArrow change={left.rankChange} />
          <span>{de.game.duelScore(left.score, right.score)}</span>
          <RankArrow change={right.rankChange} />
        </p>
      </div>
      <ol className="mt-4 flex flex-col">
        {rows.map((row, rowIndex) => {
          const fresh = rowIndex >= newFrom ? rowIndex - newFrom : -1;
          return (
            <li key={row.key} className="grid grid-cols-3 items-center border-t border-line py-2">
              {sides.map((player, side) => (
                <span
                  key={player.id}
                  className={cx("flex flex-col gap-1", side === 0 ? "order-1 items-start" : "order-3 items-end")}
                >
                  {lines.map((line) => (
                    <span key={line[0]} className="flex gap-1">
                      {line.map((position) => (
                        <ResultSquare
                          key={position}
                          result={squareResult(row.results[player.id]?.[position])}
                          appearDelayMs={fresh < 0 ? undefined : fillDelayMs(fresh, side, position)}
                        />
                      ))}
                    </span>
                  ))}
                </span>
              ))}
              <span className="order-2 flex justify-center">
                <CategoryBadge category={row.category} compact />
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
