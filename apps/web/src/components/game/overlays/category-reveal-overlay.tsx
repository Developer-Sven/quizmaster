"use client";

import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { CategoryIcon } from "@/components/ui/category-icon";
import { de } from "@/i18n/de";
import type { CategoryVisual } from "@/lib/ui/category";
import { STAGGER_MS } from "@/lib/ui/tokens";
import { CHOREOGRAPHY, categoryRevealLeaveAt, enterMotion, PANEL_FROM } from "../choreography";
import { useOverlayClock } from "../use-choreography";
import { OverlayFrame } from "./overlay-frame";

export interface CategoryRevealOverlayProps {
  category: CategoryVisual;
  /** Fragen dieses Zuges (K) */
  questionCount: number;
  /** wählende Person */
  pickerName: string;
  /** feste Kategorie (nur eine erlaubt, ADR-048): niemand hat gewählt */
  fixed?: boolean;
  /** Beginn des Vorlaufs (`phaseStartedAt` der Phase `question`) – Anker der Choreografie */
  phaseStartedAt: number;
  /** Start der ersten Frage (Serverzeit) – Ende des Vorlaufs */
  startsAt: number;
}

const REVEAL = CHOREOGRAPHY.categoryReveal;

/**
 * Kategorie-Reveal (Vorlauf der ersten Frage eines Zuges, 2 s, docs/09 §7.3): Die gewählte Kachel fliegt
 * in den Kategoriestreifen (Shared-Layout per FLIP, CategoryStrip); in der Bühnenmitte skaliert die
 * Reveal-Kachel 96 × 96 in Kategoriefarbe von 0,8 auf 1 (320 ms emphasized), darunter Name (`h2`) und
 * „3 Fragen · gewählt von Mia“ (`label`). Nach 80 % des Vorlaufs (1.600 von 2.000 ms) blendet das Overlay
 * aus, die Frage erscheint ab `startsAt`.
 */
export function CategoryRevealOverlay({
  category,
  questionCount,
  pickerName,
  fixed = false,
  phaseStartedAt,
  startsAt,
}: CategoryRevealOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const leaveAt = categoryRevealLeaveAt(phaseStartedAt, startsAt);
  const { now, enteredAt } = useOverlayClock(phaseStartedAt, [leaveAt]);
  const tile = enterMotion(
    { at: 0, duration: REVEAL.tileMs, from: { opacity: 0, scale: REVEAL.tileFromScale } },
    enteredAt,
    reduce,
  );
  const line = (position: number) =>
    enterMotion({ at: position * STAGGER_MS.list, duration: REVEAL.tileMs, from: PANEL_FROM }, enteredAt, reduce);

  return (
    <OverlayFrame testId="overlay-category-reveal" center leaving={now >= leaveAt}>
      <div className="flex flex-col items-center gap-4 text-center">
        <m.div {...tile}>
          <CategoryIcon icon={category.icon} color={category.color} frame="reveal" />
        </m.div>
        <m.h2 {...line(1)} className="text-h2 text-text">
          {category.name}
        </m.h2>
        <m.p {...line(2)} className="text-label text-text-2">
          {fixed ? de.game.revealSubtitleFixed(questionCount) : de.game.revealSubtitle(questionCount, pickerName)}
        </m.p>
      </div>
    </OverlayFrame>
  );
}
