"use client";

import type { PublicPlayer } from "@quizmaster/shared";
import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { Avatar } from "@/components/ui/avatar";
import { fillDelayMs } from "@/components/ui/board";
import { CategoryIcon } from "@/components/ui/category-icon";
import { ResultSquare } from "@/components/ui/result-square";
import { de } from "@/i18n/de";
import { findPlayer, type TurnSummary } from "@/lib/client/game-view";
import type { CategoryVisual } from "@/lib/ui/category";
import { cx } from "@/lib/ui/cx";
import { transitions } from "@/lib/ui/motion-presets";
import { squareResult } from "@/lib/ui/results";
import { DURATION_MS } from "@/lib/ui/tokens";
import { OverlayFrame } from "./overlay-frame";

export interface TurnSummaryOverlayProps {
  /** Zug-Ergebnis aus der Tafelzeile des Zuges; `null`, solange sie fehlt */
  summary: TurnSummary | null;
  players: readonly PublicPlayer[];
  category: CategoryVisual;
}

/** Panel fährt von unten hoch (docs/09 §7.7). */
const PANEL_RISE_PX = 48;

/** Kästchen je Zeile: bis 3 nebeneinander wie auf der Tafel (ADR-032), darüber bricht es um (K 1–10). */
const SQUARES_PER_LINE = 3;

function lines(count: number): number[][] {
  const positions = Array.from({ length: count }, (_, position) => position);
  const result: number[][] = [];
  for (let start = 0; start < positions.length; start += SQUARES_PER_LINE) {
    result.push(positions.slice(start, start + SQUARES_PER_LINE));
  }
  return result;
}

/**
 * Zug-Ergebnis (Phase `turn_summary`, 4 s, docs/09 §7.7): Panel fährt hoch (320 ms); Kopf = Kategorie,
 * Zeilen = Personen nach Punkten dieses Zuges mit K Kästchen (füllen sich nacheinander, 80 ms) und „+2“;
 * die beste(n) Person(en) mit 1 px orangem Rahmen. Kein Lob-Text.
 */
export function TurnSummaryOverlay({ summary, players, category }: TurnSummaryOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const best = new Set(summary?.bestPlayerIds ?? []);
  return (
    <OverlayFrame testId="overlay-turn-summary" center>
      <m.div
        initial={{ opacity: 0, y: reduce ? 0 : PANEL_RISE_PX }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduce ? transitions.fade : transitions.enter}
        className="rounded-xl border border-line bg-surface-1 p-5 shadow-level-2"
      >
        <div className="flex items-center gap-3">
          <CategoryIcon icon={category.icon} color={category.color} frame="tile" />
          <h2 className="min-w-0 flex-1 text-h2 text-text">{category.name}</h2>
        </div>
        <ol className="mt-4 flex flex-col gap-2">
          {(summary?.entries ?? []).map((entry, row) => {
            const player = findPlayer(players, entry.playerId);
            if (!player) return null;
            return (
              <li
                key={entry.playerId}
                data-testid="turn-summary-row"
                data-best={best.has(entry.playerId) || undefined}
                className={cx(
                  "flex min-h-12 items-center gap-3 rounded-lg border px-3 py-2",
                  best.has(entry.playerId) ? "border-primary" : "border-transparent",
                )}
              >
                <Avatar name={player.name} color={player.color} size={32} resigned={player.status === "resigned"} />
                <span
                  className={cx(
                    "min-w-0 flex-1 truncate text-body",
                    player.status === "resigned" ? "text-text-2 line-through" : "text-text",
                  )}
                >
                  {player.name}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  {lines(entry.results.length).map((line) => (
                    <span key={line[0]} className="flex gap-1">
                      {line.map((position) => (
                        <ResultSquare
                          key={position}
                          result={squareResult(entry.results[position])}
                          appearDelayMs={DURATION_MS.slow + fillDelayMs(0, row, position)}
                        />
                      ))}
                    </span>
                  ))}
                </span>
                <span className="w-8 shrink-0 text-right text-label text-text tabular-nums">
                  {de.game.pointsGained(entry.points)}
                </span>
              </li>
            );
          })}
        </ol>
      </m.div>
    </OverlayFrame>
  );
}
