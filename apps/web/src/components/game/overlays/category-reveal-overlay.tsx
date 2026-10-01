"use client";

import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { CategoryIcon } from "@/components/ui/category-icon";
import { de } from "@/i18n/de";
import { CATEGORY_REVEAL_EXIT_BEFORE_START_MS } from "@/lib/client/phase-clock";
import { useServerNow } from "@/lib/client/use-server-clock";
import type { CategoryVisual } from "@/lib/ui/category";
import { transitions } from "@/lib/ui/motion-presets";
import { OverlayFrame } from "./overlay-frame";

export interface CategoryRevealOverlayProps {
  category: CategoryVisual;
  /** Fragen dieses Zuges (K) */
  questionCount: number;
  /** wählende Person */
  pickerName: string;
  /** Start der ersten Frage (Serverzeit) – Ende des Vorlaufs */
  startsAt: number;
}

/**
 * Kategorie-Reveal (Vorlauf der ersten Frage eines Zuges, 2 s, docs/09 §7.3): Reveal-Kachel 96 × 96 in
 * Kategoriefarbe skaliert von 0,8 auf 1 (320 ms emphasized), darunter Name (`h2`) und „3 Fragen · gewählt
 * von Mia“ (`label`); blendet 400 ms vor `startsAt` aus. Die Shared-Layout-Animation der Kachel in den
 * Kategoriestreifen ergänzt die Choreografie-Phase.
 */
export function CategoryRevealOverlay({ category, questionCount, pickerName, startsAt }: CategoryRevealOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const exitAt = startsAt - CATEGORY_REVEAL_EXIT_BEFORE_START_MS;
  const now = useServerNow([exitAt]);
  const visible = now < exitAt;
  return (
    <OverlayFrame testId="overlay-category-reveal" center>
      <AnimatePresence initial={false}>
        {visible ? (
          <m.div
            key="reveal"
            exit={{ opacity: 0, transition: transitions.exit }}
            className="flex flex-col items-center gap-4 text-center"
          >
            <m.div
              initial={{ opacity: 0, scale: reduce ? 1 : 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={reduce ? transitions.fade : transitions.enter}
            >
              <CategoryIcon icon={category.icon} color={category.color} frame="reveal" />
            </m.div>
            <h2 className="text-h2 text-text">{category.name}</h2>
            <p className="text-label text-text-2">{de.game.revealSubtitle(questionCount, pickerName)}</p>
          </m.div>
        ) : null}
      </AnimatePresence>
    </OverlayFrame>
  );
}
