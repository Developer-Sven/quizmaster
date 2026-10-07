"use client";

import type { BoardRow, PublicPlayer } from "@quizmaster/shared";
import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { de } from "../../../i18n/de";
import { type CategoryCatalog, duelSides, firstRowOfRound } from "../../../lib/client/game-view";
import { cx } from "../../../lib/ui/cx";
import { ArrowDownIcon, ArrowUpIcon } from "../../../lib/ui/icons";
import { squareResult } from "../../../lib/ui/results";
import { Avatar } from "../../ui/avatar";
import { Board, type BoardPlayer, type BoardRowData, fillDelayMs } from "../../ui/board";
import { CategoryBadge } from "../../ui/category-badge";
import { ResultSquare } from "../../ui/result-square";
import { boardPlayers, boardRowsUntil } from "../board-data";
import { CHOREOGRAPHY, enterMotion, momentAhead, PANEL_FROM, remainingDelayMs } from "../choreography";
import { useOverlayClock } from "../use-choreography";
import { OverlayFrame } from "./overlay-frame";

/** Weiter hier exportiert (bestehende Importe); die reinen Funktionen liegen in ../board-data.ts. */
export { boardPlayers, boardRowsUntil } from "../board-data";

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
  /** Serverzeit des Phasenbeginns – Anker der Choreografie */
  phaseStartedAt: number;
}

/**
 * Die Tafel (Board) füllt ihre neuen Zeilen ab dem Einhängen. Wer später einsteigt (Reconnect), sieht sie
 * sofort gefüllt – ein Nachholen der ganzen Füll-Animation wäre eine Wiederholung.
 */
const BOARD_FILL_LATE_MS = 200;

/**
 * Rundentafel (Phase `round_board`, Standard 7 s bzw. Weiter-Einstellung, docs/09 §7.8, ADR-045): Vollbild-Panel
 * „Runde 1 von 3“; 2 Personen im Duell-Layout (links Person A, Mitte Kategorie, rechts Person B, oben „5 : 4“),
 * 3–8 als `Board`-Tabelle.
 * Die neuen Zeilen der Runde füllen sich animiert; Platzwechsel mit `arrow-up`/`arrow-down` neben den Summen.
 */
export function RoundBoardOverlay({
  board,
  participants,
  round,
  rounds,
  categories,
  questionsPerTurn,
  selfId,
  phaseStartedAt,
}: RoundBoardOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const { enteredAt } = useOverlayClock(phaseStartedAt, []);
  const panel = enterMotion({ at: 0, duration: CHOREOGRAPHY.roundBoard.panelMs, from: PANEL_FROM }, enteredAt, reduce);
  const animateFill = momentAhead(0, enteredAt, BOARD_FILL_LATE_MS);
  const rows = boardRowsUntil(board, round, categories);
  const players = boardPlayers(board, participants, round);
  const newFrom = firstRowOfRound(
    board.filter((row) => row.round <= round),
    round,
  );
  const sides = duelSides(participants, selfId);
  return (
    <OverlayFrame testId="overlay-round-board">
      <m.div {...panel} className="flex flex-col gap-4">
        <h2 className="text-h2 text-text">{de.game.roundBoardTitle(round, rounds)}</h2>
        {sides ? (
          <DuelBoard
            left={players.find((player) => player.id === sides[0].id)}
            right={players.find((player) => player.id === sides[1].id)}
            rows={rows}
            newFrom={newFrom}
            questionsPerTurn={questionsPerTurn}
            enteredAt={enteredAt}
          />
        ) : (
          <Board
            players={players}
            rows={rows}
            questionsPerTurn={questionsPerTurn}
            animateFromRow={animateFill ? newFrom : undefined}
          />
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
  /** Einstieg relativ zum Phasenbeginn (ms): bereits gefüllte Kästchen erscheinen sofort */
  enteredAt: number;
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

/** Platzwechsel neben dem Gesamtstand – nur Bild; Screenreader hören ihn mit Namen im Spielstand-Text. */
function RankArrow({ change }: { change: "up" | "down" | null | undefined }) {
  if (change === "up") return <ArrowUpIcon aria-hidden="true" size={16} className="text-text-2" />;
  if (change === "down") return <ArrowDownIcon aria-hidden="true" size={16} className="text-text-2" />;
  return null;
}

/** Spielstand des Duells mit Namen und Platzwechseln, z. B. „Mia: 8 Punkte, Ben: 11 Punkte. Ben: Platz verbessert“. */
export function duelStandingText(left: BoardPlayer, right: BoardPlayer): string {
  const change = (player: BoardPlayer) =>
    player.rankChange === "up"
      ? de.a11y.rankUpOf(player.name)
      : player.rankChange === "down"
        ? de.a11y.rankDownOf(player.name)
        : null;
  return [de.a11y.duelScore(left.name, left.score, right.name, right.score), change(left), change(right)]
    .filter((part): part is string => part !== null)
    .join(". ");
}

/**
 * Duell-Layout der Tafel (2 Personen, docs/01 §Rundentafel, docs/09 §7.8): links Person A, Mitte Kategorie,
 * rechts Person B, oben der Gesamtstand. Als Tabelle in Lesereihenfolge (WCAG 1.3.1, 1.3.2): Spaltenköpfe sind
 * die beiden Personen, Zeilenköpfe die Kategorie – Screenreader nennen so zu jedem Kästchen Person und Zug.
 */
function DuelBoard({ left, right, rows, newFrom, questionsPerTurn, enteredAt }: DuelBoardProps) {
  if (!left || !right) return null;
  const lines = squareLines(Math.max(1, questionsPerTurn));
  const head = (player: BoardPlayer) => (
    <th scope="col" className="w-1/2 pb-4 align-top font-normal">
      <span className="flex min-w-0 flex-col items-center gap-1">
        <Avatar name={player.name} color={player.color} size={56} resigned={player.resigned} />
        <span
          className={cx(
            "max-w-full text-center text-label wrap-break-word",
            player.resigned ? "text-text-2 line-through" : "text-text",
          )}
        >
          {player.name}
        </span>
        {player.resigned ? <span className="sr-only">{de.a11y.statusResigned}</span> : null}
      </span>
    </th>
  );
  const squares = (row: BoardRowData, rowIndex: number, player: BoardPlayer, side: 0 | 1) => {
    const fresh = rowIndex >= newFrom ? rowIndex - newFrom : -1;
    return (
      <td className="py-2">
        <span className={cx("flex flex-col gap-1", side === 0 ? "items-start" : "items-end")}>
          {lines.map((line) => (
            <span key={line[0]} className="flex gap-1">
              {line.map((position) => (
                <ResultSquare
                  key={position}
                  result={squareResult(row.results[player.id]?.[position])}
                  appearDelayMs={
                    fresh < 0
                      ? undefined
                      : remainingDelayMs(
                          fillDelayMs(fresh, side, position),
                          CHOREOGRAPHY.roundBoard.squareMs,
                          enteredAt,
                        )
                  }
                />
              ))}
            </span>
          ))}
        </span>
      </td>
    );
  };
  return (
    // Wie die Tafel ab 3 Personen: Wird sie bei großer Schrift breiter als die Spalte, scrollt nur sie
    // waagerecht (per Tastatur erreichbar, WCAG 2.1.1) – nie die ganze Seite.
    <section
      aria-label={de.a11y.boardCaption}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: waagerecht scrollbare Tafel muss per Tastatur scrollbar sein
      tabIndex={0}
      className="relative isolate overflow-x-auto rounded-xl border border-line bg-surface-1 p-4"
    >
      <p className="sr-only">{duelStandingText(left, right)}</p>
      <table className="w-full border-collapse">
        <caption className="sr-only">{de.a11y.boardCaption}</caption>
        <thead>
          <tr>
            {head(left)}
            <th scope="col" className="px-2 pb-4 align-middle font-normal whitespace-nowrap">
              <span className="sr-only">{de.a11y.boardCategory}</span>
              <span aria-hidden="true" className="flex items-center gap-1 text-h1 text-text tabular-nums">
                <RankArrow change={left.rankChange} />
                <span>{de.game.duelScore(left.score, right.score)}</span>
                <RankArrow change={right.rankChange} />
              </span>
            </th>
            {head(right)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.key} className="border-t border-line">
              {squares(row, rowIndex, left, 0)}
              <th scope="row" className="py-2 font-normal">
                <span className="flex justify-center">
                  <CategoryBadge category={row.category} compact />
                </span>
              </th>
              {squares(row, rowIndex, right, 1)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
