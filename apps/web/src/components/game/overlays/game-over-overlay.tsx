"use client";

import type { BoardRow, PublicLobbyState, PublicPlayer } from "@quizmaster/shared";
import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useId, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Board } from "@/components/ui/board";
import { Button } from "@/components/ui/button";
import { Podium } from "@/components/ui/podium";
import { type RankingEntry, RankingList } from "@/components/ui/ranking-list";
import { de } from "@/i18n/de";
import { type CategoryCatalog, duelOutcome, duelSides, findPlayer } from "@/lib/client/game-view";
import { cx } from "@/lib/ui/cx";
import { ChevronDownIcon, ChevronUpIcon, CrownIcon } from "@/lib/ui/icons";
import { transitions } from "@/lib/ui/motion-presets";
import { DURATION_MS, EASING, seconds } from "@/lib/ui/tokens";
import { OverlayFrame } from "./overlay-frame";
import { boardPlayers, boardRowsUntil } from "./round-board-overlay";

type GameResults = NonNullable<PublicLobbyState["results"]>;

/** Ab dieser Länge ist die Überschrift bei 360 px zu breit für `display` (44 px). */
const LONG_HEADLINE_CHARS = 11;

export interface GameOverOverlayProps {
  results: GameResults | null;
  /** Personen des Spiels (Wahl-Reihenfolge) */
  participants: readonly PublicPlayer[];
  board: readonly BoardRow[];
  categories: CategoryCatalog;
  questionsPerTurn: number;
  selfId: string | null;
  /** Vorschau: Tafel anfangs aufgeklappt */
  defaultBoardOpen?: boolean;
}

/** Überschrift aus Sicht der eigenen Person (docs/09 §11 Ergebnis-Texte). */
export function resultHeadline(
  results: GameResults,
  participants: readonly PublicPlayer[],
  selfId: string | null,
): string {
  if (participants.length === 2) {
    const outcome = duelOutcome(results, selfId);
    if (outcome === "won") return de.result.won;
    if (outcome === "lost") return de.result.lost;
    if (outcome === "draw") return de.result.draw;
  }
  const own = results.ranking.find((entry) => entry.playerId === selfId);
  if (own) {
    if (own.status === "resigned") return de.result.resigned;
    if (results.outcome === "draw") return de.result.draw;
    return own.place === 1 ? de.result.won : de.result.place(own.place);
  }
  const winners = results.ranking.filter((entry) => entry.place === 1 && entry.status === "active");
  const winner = winners.length === 1 ? findPlayer(participants, winners[0]?.playerId) : undefined;
  return winner ? de.result.playerWins(winner.name) : de.result.draw;
}

function rankingEntries(results: GameResults, participants: readonly PublicPlayer[]): RankingEntry[] {
  return results.ranking.flatMap((entry) => {
    const player = findPlayer(participants, entry.playerId);
    if (!player) return [];
    return [
      {
        playerId: entry.playerId,
        place: entry.place,
        name: player.name,
        color: player.color,
        score: entry.score,
        status: entry.status,
      },
    ];
  });
}

/**
 * Spielende (Phase `game_over`, docs/09 §6 + §7.9): Scrim, Ergebnis-Headline blendet ein (0,96 → 1).
 * 2 Personen: „Gewonnen“/„Verloren“/„Unentschieden“, „7 : 5“, beide Avatare 88 px, Sieger:in mit Krone
 * (Pop). 3–8: Podest (Säulen wachsen 3 → 2 → 1) und Rangliste. Darunter die Tafel, eingeklappt
 * („Spielverlauf“). Die Aktionen (Revanche, Fragen ansehen, Lobby verlassen) stehen in der Aktionsleiste.
 */
export function GameOverOverlay({
  results,
  participants,
  board,
  categories,
  questionsPerTurn,
  selfId,
  defaultBoardOpen = false,
}: GameOverOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const [boardOpen, setBoardOpen] = useState(defaultBoardOpen);
  const boardId = useId();
  if (!results)
    return (
      <OverlayFrame testId="overlay-game-over" scrim>
        {null}
      </OverlayFrame>
    );

  const lastRound = board.reduce((max, row) => Math.max(max, row.round), 0);
  const entries = rankingEntries(results, participants);
  const duel = duelSides(participants, selfId);
  const headline = resultHeadline(results, participants, selfId);

  return (
    <OverlayFrame testId="overlay-game-over" scrim>
      <div className="flex flex-col gap-6 pb-4">
        <m.p
          data-testid="game-over-headline"
          initial={{ opacity: 0, scale: reduce ? 1 : 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: seconds(DURATION_MS.overlay), ease: EASING.emphasized }}
          className={cx(
            "pt-4 text-center text-text",
            // „Unentschieden“ passt in `display` erst ab 390 px Breite – darunter `h1`, statt abzuschneiden.
            headline.length > LONG_HEADLINE_CHARS ? "text-h1 xs:text-display" : "text-display",
          )}
        >
          {headline}
        </m.p>

        {duel ? (
          <DuelResult results={results} left={duel[0]} right={duel[1]} reduce={reduce} />
        ) : (
          <>
            <Podium entries={entries.slice(0, 3)} animate />
            <m.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ ...transitions.fade, delay: seconds(DURATION_MS.overlay + DURATION_MS.slow) }}
            >
              <RankingList entries={entries} />
            </m.div>
          </>
        )}

        {board.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex">
              <Button
                variant="ghost"
                size="compact"
                icon={boardOpen ? ChevronUpIcon : ChevronDownIcon}
                aria-expanded={boardOpen}
                aria-controls={boardId}
                onClick={() => setBoardOpen((open) => !open)}
                data-testid="game-over-history"
              >
                {de.result.history}
              </Button>
            </div>
            <div id={boardId} hidden={!boardOpen}>
              {boardOpen ? (
                <Board
                  players={boardPlayers(board, participants, lastRound).map((player) => ({
                    ...player,
                    rankChange: null,
                  }))}
                  rows={boardRowsUntil(board, lastRound, categories)}
                  questionsPerTurn={questionsPerTurn}
                  label={de.result.history}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </OverlayFrame>
  );
}

interface DuelResultProps {
  results: GameResults;
  left: PublicPlayer;
  right: PublicPlayer;
  reduce: boolean;
}

/** Duell-Ergebnis: „7 : 5“ und beide Avatare 88 px; die Krone poppt über der Sieger:in (docs/09 §7.9). */
function DuelResult({ results, left, right, reduce }: DuelResultProps) {
  const scoreOf = (player: PublicPlayer) =>
    results.ranking.find((entry) => entry.playerId === player.id)?.score ?? player.score;
  const winnerId =
    results.outcome === "draw"
      ? null
      : (results.ranking.find((entry) => entry.place === 1 && entry.status === "active")?.playerId ?? null);
  const sides = [left, right] as const;
  return (
    <div className="flex flex-col items-center gap-6">
      <p data-testid="game-over-score" className="text-h1 text-text tabular-nums">
        {de.game.duelScore(scoreOf(left), scoreOf(right))}
      </p>
      <div className="flex w-full justify-center gap-10">
        {sides.map((player, side) => {
          const winner = player.id === winnerId;
          return (
            <m.div
              key={player.id}
              initial={{ opacity: 0, x: reduce ? 0 : side === 0 ? -24 : 24 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ ...(reduce ? transitions.fade : transitions.enter), delay: seconds(DURATION_MS.overlay) }}
              className="flex min-w-0 flex-col items-center gap-2"
            >
              <span className="flex h-6 items-end">
                {winner ? (
                  <CrownIcon size={24} aria-hidden="true" className="text-primary motion-safe:animate-crown-pop" />
                ) : null}
              </span>
              <Avatar
                name={player.name}
                color={player.color}
                size={88}
                winner={winner}
                resigned={player.status === "resigned"}
                label={player.name}
              />
              <span
                className={cx(
                  "max-w-28 truncate text-label",
                  player.status === "resigned" ? "text-text-2 line-through" : "text-text",
                )}
              >
                {player.name}
              </span>
            </m.div>
          );
        })}
      </div>
    </div>
  );
}
