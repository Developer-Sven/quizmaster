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

/** Anzeige-Reihenfolge 2-1-3 (docs/09 §5): Eintrag 0 in der Mitte, 1 links, 2 rechts. */
const COLUMN_ORDER = ["order-2", "order-1", "order-3"] as const;

/**
 * Säulenhöhe nach tatsächlichem Platz, nicht nach Position: 1 → 128, 2 → 96, 3 → 72 (docs/09 §5).
 * Gleichstand = gleicher Platz (ADR-017) steht so auf gleich hohen Säulen.
 */
function columnHeight(place: number): string {
  if (place <= 1) return "h-32";
  return place === 2 ? "h-24" : "h-18";
}

/**
 * Wachstumsschritt einer Säule (Platz 3 → 2 → 1, je 160 ms, docs/09 §7.9): gezählt über die
 * verschiedenen Plätze auf dem Podest, damit Gleichplatzierte gemeinsam und ohne Leerlauf wachsen.
 */
export function podiumGrowStep(place: number, podiumPlaces: readonly number[]): number {
  const descending = [...new Set(podiumPlaces)].sort((a, b) => b - a);
  return Math.max(0, descending.indexOf(place));
}

/**
 * Podium (docs/09 §5): 3 Säulen (2-1-3), Avatar 56 oben, Platzziffer. Im DOM steht Platz 1 zuerst
 * (Screenreader-Reihenfolge), optisch 2-1-3.
 */
export function Podium({ entries, animate = false }: PodiumProps) {
  const reduce = useReducedMotion() ?? false;
  const podium = entries.slice(0, COLUMN_ORDER.length);
  const places = podium.map((entry) => entry.place);
  return (
    <MotionProvider>
      <ol aria-label={de.result.podium} className="flex items-end justify-center gap-3">
        {podium.map((entry, index) => {
          const delay = seconds(podiumGrowStep(entry.place, places) * STAGGER_MS.podium);
          return (
            <li
              key={entry.playerId}
              className={cx("flex w-24 min-w-0 flex-col items-center gap-2", COLUMN_ORDER[index])}
            >
              <Avatar name={entry.name} color={entry.color} size={56} winner={entry.place === 1} />
              <span className="max-w-full truncate text-label text-text">{entry.name}</span>
              <m.span
                className={cx(
                  "flex w-full origin-bottom justify-center rounded-t-lg bg-surface-2 pt-2",
                  columnHeight(entry.place),
                )}
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
