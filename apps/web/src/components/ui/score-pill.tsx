"use client";

import { AnimatePresence, animate, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useState } from "react";
import { de } from "../../i18n/de";
import { MotionProvider } from "../../lib/ui/motion";
import { transitions } from "../../lib/ui/motion-presets";
import { OFFSET_PX } from "../../lib/ui/tokens";

export interface ScorePillProps {
  score: number;
}

interface Gain {
  /** Punktestand nach dem Zuwachs – eindeutig, da Punkte nur steigen */
  key: number;
  amount: number;
}

/**
 * ScorePill (docs/09 §5, §8): Zahl im Stil `label`, tabular, 28 hoch. Steigt `score`, erscheint
 * „+1“ (16 px nach oben, ausblendend, 480 ms) und die Zahl zählt hoch (400 ms). Reduzierte
 * Bewegung: „+1“ blendet nur, die Zahl springt. Sinkt `score` (Revanche), springt die Zahl.
 */
export function ScorePill({ score }: ScorePillProps) {
  const reduce = useReducedMotion() ?? false;
  const [shown, setShown] = useState(score);
  const [gains, setGains] = useState<readonly Gain[]>([]);
  const value = useMotionValue(score);
  const rounded = useTransform(value, (latest) => Math.round(latest));

  if (score !== shown) {
    if (score > shown) setGains((current) => [...current, { key: score, amount: score - shown }]);
    setShown(score);
  }

  useEffect(() => {
    // Hochzählen nur bei Zuwachs; ein Zurücksetzen (Revanche) springt sofort.
    const countUp = !reduce && score > value.get();
    const controls = animate(value, score, countUp ? transitions.count : { duration: 0 });
    return () => controls.stop();
  }, [score, reduce, value]);

  return (
    <MotionProvider>
      <span className="relative inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-surface-2 px-2 text-label text-text tabular-nums">
        <m.span aria-hidden="true">{rounded}</m.span>
        <span className="sr-only">{de.result.points(score)}</span>
        <AnimatePresence>
          {gains.map((gain) => (
            <m.span
              key={gain.key}
              aria-hidden="true"
              className="pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 text-label text-success tabular-nums"
              initial={{ opacity: 1, y: 0 }}
              animate={{ opacity: 0, y: reduce ? 0 : -OFFSET_PX.float }}
              transition={transitions.float}
              onAnimationComplete={() => setGains((current) => current.filter((entry) => entry.key !== gain.key))}
            >
              {de.game.pointsGained(gain.amount)}
            </m.span>
          ))}
        </AnimatePresence>
      </span>
    </MotionProvider>
  );
}
