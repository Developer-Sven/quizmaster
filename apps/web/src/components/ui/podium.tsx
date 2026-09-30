"use client";

import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import { MotionProvider } from "../../lib/ui/motion";
import { transitions } from "../../lib/ui/motion-presets";
import type { PlayerColor } from "../../lib/ui/player";
import { DURATION_MS, EASING, STAGGER_MS, seconds } from "../../lib/ui/tokens";
import { Avatar } from "./avatar";

export interface PodiumEntry {
  playerId: string;
  /** tatsächlicher Platz (bei Gleichstand doppelt möglich) */
  place: number;
  name: string;
  color: PlayerColor;
  score: number;
}

export interface PodiumProps {
  /** Rangliste in Reihenfolge; die ersten drei stehen auf dem Podest */
  entries: readonly PodiumEntry[];
  /** Säulen wachsen gestaffelt (Platz 3 → 2 → 1, je 160 ms); bei reduzierter Bewegung nur Einblenden */
  animate?: boolean;
}

/** Säulen in Anzeige-Reihenfolge 2-1-3 mit Höhen 96/128/72 (docs/09 §5). */
const COLUMNS = [
  { rank: 1, order: "order-2", height: "h-32", growStep: 2 },
  { rank: 2, order: "order-1", height: "h-24", growStep: 1 },
  { rank: 3, order: "order-3", height: "h-18", growStep: 0 },
] as const;

/**
 * Podium (docs/09 §5): 3 Säulen (2-1-3), Avatar 56 oben, Platzziffer. Im DOM steht Platz 1 zuerst
 * (Screenreader-Reihenfolge), optisch 2-1-3.
 */
export function Podium({ entries, animate = false }: PodiumProps) {
  const reduce = useReducedMotion() ?? false;
  return (
    <MotionProvider>
      <ol aria-label={de.result.podium} className="flex items-end justify-center gap-3">
        {COLUMNS.map((column, index) => {
          const entry = entries[index];
          if (!entry) return null;
          const delay = seconds(column.growStep * STAGGER_MS.podium);
          return (
            <li key={entry.playerId} className={cx("flex w-24 min-w-0 flex-col items-center gap-2", column.order)}>
              <Avatar name={entry.name} color={entry.color} size={56} winner={entry.place === 1} />
              <span className="max-w-full truncate text-label text-text">{entry.name}</span>
              <m.span
                className={cx("flex w-full origin-bottom justify-center rounded-t-lg bg-surface-2 pt-2", column.height)}
                initial={animate ? (reduce ? { opacity: 0 } : { scaleY: 0 }) : false}
                animate={reduce ? { opacity: 1 } : { scaleY: 1 }}
                transition={
                  reduce
                    ? { ...transitions.fade, delay }
                    : { duration: seconds(DURATION_MS.slow), ease: EASING.emphasized, delay }
                }
              >
                <span className="text-h1 text-text-2 tabular-nums">
                  <span className="sr-only">{de.result.place(entry.place)}, </span>
                  <span aria-hidden="true">{entry.place}</span>
                  <span className="sr-only">, {de.result.points(entry.score)}</span>
                </span>
              </m.span>
            </li>
          );
        })}
      </ol>
    </MotionProvider>
  );
}
