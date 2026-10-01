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
import { type CategoryCatalog, duelSides, findPlayer } from "@/lib/client/game-view";
import { elapsedMs } from "@/lib/client/phase-clock";
import { cx } from "@/lib/ui/cx";
import { ChevronDownIcon, ChevronUpIcon, CrownIcon } from "@/lib/ui/icons";
import { EASING, seconds } from "@/lib/ui/tokens";
import {
  CHOREOGRAPHY,
  enterMotion,
  entranceDone,
  momentAhead,
  motionPlan,
  REDUCED_FADE_MS,
  sideOffset,
} from "../choreography";
import { resultHeadline } from "../results";
import { useOverlayClock } from "../use-choreography";
import { OverlayFrame } from "./overlay-frame";
import { boardPlayers, boardRowsUntil } from "./round-board-overlay";

type GameResults = NonNullable<PublicLobbyState["results"]>;

/** Ab dieser Länge ist die Überschrift bei 360 px zu breit für `display` (44 px). */
const LONG_HEADLINE_CHARS = 11;

const END = CHOREOGRAPHY.gameOver;

/** Podest wächst 3 → 2 → 1 (je 160 ms, 320 ms); danach erscheint die Rangliste. */
const RANKING_AT_MS = END.podiumAtMs + 2 * END.podiumStaggerMs + END.columnMs;

/** Das Podest startet seine Säulen beim Einhängen: Wer deutlich später einsteigt, sieht es fertig. */
const PODIUM_LATE_MS = END.podiumStaggerMs;

export interface GameOverOverlayProps {
  results: GameResults | null;
  /** Personen des Spiels (Wahl-Reihenfolge) */
  participants: readonly PublicPlayer[];
  board: readonly BoardRow[];
  categories: CategoryCatalog;
  questionsPerTurn: number;
  selfId: string | null;
  /** Serverzeit des Phasenbeginns – Anker der Choreografie */
  phaseStartedAt: number;
  /** Vorschau: Tafel anfangs aufgeklappt */
  defaultBoardOpen?: boolean;
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
 * Spielende (Phase `game_over`, docs/09 §6 + §7.9): 0–480 ms Scrim, die Ergebnis-Headline blendet ein
 * (0,96 → 1). 2 Personen: „7 : 5“, beide Avatare 88 px fahren von außen ein, die Krone poppt danach über der
 * Sieger:in (0 → 1,15 → 1, 320 ms). 3–8: Podest-Säulen wachsen gestaffelt (Platz 3 → 2 → 1, je 160 ms), dann
 * erscheint die Rangliste. Darunter die Tafel, eingeklappt („Spielverlauf“). Kein Konfetti, kein Lichteffekt.
 * Ton `win`/`lose`/`turn` als Cue der Bühne. Wer später einsteigt, sieht den Endzustand ohne Wiederholung.
 */
export function GameOverOverlay({
  results,
  participants,
  board,
  categories,
  questionsPerTurn,
  selfId,
  phaseStartedAt,
  defaultBoardOpen = false,
}: GameOverOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const [boardOpen, setBoardOpen] = useState(defaultBoardOpen);
  const boardId = useId();
  const { now, enteredAt } = useOverlayClock(phaseStartedAt, [phaseStartedAt + END.podiumAtMs]);
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
  const headlineMotion = enterMotion(
    { at: 0, duration: END.headlineMs, from: { opacity: 0, scale: END.headlineFromScale } },
    enteredAt,
    reduce,
  );
  // Das Podest erscheint nach der Headline (480 ms); bis dahin hält eine unsichtbare Kopie den Platz frei.
  // Podium wächst selbst (bei reduzierter Bewegung blendet es nur ein, docs/09 §7 „Podest ohne Wachstum“).
  const podiumShown = elapsedMs(phaseStartedAt, now) >= END.podiumAtMs;
  const podiumAnimates = momentAhead(END.podiumAtMs, enteredAt, PODIUM_LATE_MS);
  const ranking = enterMotion({ at: RANKING_AT_MS, duration: END.columnMs, from: { opacity: 0 } }, enteredAt, reduce);

  return (
    <OverlayFrame testId="overlay-game-over" scrim>
      <div className="flex flex-col gap-6 pb-4">
        <m.p
          {...headlineMotion}
          data-testid="game-over-headline"
          className={cx(
            "pt-4 text-center text-text",
            // „Unentschieden“ passt in `display` erst ab 390 px Breite – darunter `h1`, statt abzuschneiden.
            headline.length > LONG_HEADLINE_CHARS ? "text-h1 xs:text-display" : "text-display",
          )}
        >
          {headline}
        </m.p>

        {duel ? (
          <DuelResult results={results} left={duel[0]} right={duel[1]} reduce={reduce} enteredAt={enteredAt} />
        ) : (
          <>
            {podiumShown ? (
              <Podium entries={entries.slice(0, 3)} animate={podiumAnimates} />
            ) : (
              <div aria-hidden="true" className="invisible">
                <Podium entries={entries.slice(0, 3)} />
              </div>
            )}
            <m.div {...ranking}>
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
  /** Einstieg relativ zum Phasenbeginn (ms) */
  enteredAt: number;
}

/**
 * Duell-Ergebnis: „7 : 5“ und beide Avatare 88 px (fahren von außen ein); die Krone poppt danach über der
 * Sieger:in (docs/09 §7.9 / §8: 0 → 1,15 → 1, 320 ms emphasized), bei reduzierter Bewegung nur Überblendung.
 */
function DuelResult({ results, left, right, reduce, enteredAt }: DuelResultProps) {
  const scoreOf = (player: PublicPlayer) =>
    results.ranking.find((entry) => entry.playerId === player.id)?.score ?? player.score;
  const winnerId =
    results.outcome === "draw"
      ? null
      : (results.ranking.find((entry) => entry.place === 1 && entry.status === "active")?.playerId ?? null);
  const sides = [left, right] as const;
  const score = enterMotion({ at: END.avatarsAtMs, duration: END.columnMs, from: { opacity: 0 } }, enteredAt, reduce);
  return (
    <div className="flex flex-col items-center gap-6">
      <m.p {...score} data-testid="game-over-score" className="text-h1 text-text tabular-nums">
        {de.game.duelScore(scoreOf(left), scoreOf(right))}
      </m.p>
      <div className="flex w-full justify-center gap-10">
        {sides.map((player, side) => {
          const winner = player.id === winnerId;
          const entrance = enterMotion(
            {
              at: END.avatarsAtMs,
              duration: END.avatarMs,
              from: { opacity: 0, x: sideOffset(side === 0 ? 0 : 1) },
            },
            enteredAt,
            reduce,
          );
          return (
            <m.div key={player.id} {...entrance} className="flex min-w-0 flex-col items-center gap-2">
              <span className="flex h-6 items-end">
                {winner ? <Crown reduce={reduce} enteredAt={enteredAt} /> : null}
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

/** Krone der Sieger:in: poppt nach dem Einfahren der Avatare (0 → 1,15 → 1); reduziert nur Überblendung. */
function Crown({ reduce, enteredAt }: { reduce: boolean; enteredAt: number }) {
  const done = entranceDone(END.crownAtMs, END.crownMs, enteredAt);
  const delay = seconds(END.crownAtMs - enteredAt);
  if (done) return <CrownIcon size={24} aria-hidden="true" className="text-primary" />;
  const pop = motionPlan(reduce).crownPop;
  return (
    <m.span
      aria-hidden="true"
      className="flex text-primary"
      initial={pop ? { scale: 0 } : { opacity: 0 }}
      animate={pop ? { scale: [0, 1.15, 1] } : { opacity: 1 }}
      transition={
        pop
          ? { duration: seconds(END.crownMs), times: [0, 0.6, 1], ease: EASING.emphasized, delay }
          : { duration: seconds(REDUCED_FADE_MS), ease: EASING.standard, delay }
      }
    >
      <CrownIcon size={24} />
    </m.span>
  );
}
