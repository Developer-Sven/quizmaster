"use client";

import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import { MotionProvider } from "../../lib/ui/motion";
import { transitions } from "../../lib/ui/motion-presets";
import type { SquareResult } from "../../lib/ui/results";
import { seconds } from "../../lib/ui/tokens";

const fillClasses: Record<SquareResult, string> = {
  correct: "bg-success",
  wrong: "bg-danger",
  open: "bg-line",
  none: "border-2 border-danger bg-danger-tint",
};

const labels: Record<SquareResult, string> = {
  correct: de.a11y.resultCorrect,
  wrong: de.a11y.resultWrong,
  open: de.a11y.resultOpen,
  none: de.a11y.resultNone,
};

export interface ResultSquareProps {
  result: SquareResult;
  /** Füllt sich nach dieser Verzögerung animiert (Zug-Ergebnis 80 ms Abstand, neueste Tafelzeile) */
  appearDelayMs?: number;
}

/** ResultSquare (docs/09 §5): 14 × 14, `radius-sm`; Bedeutung zusätzlich als Screenreader-Text. */
export function ResultSquare({ result, appearDelayMs }: ResultSquareProps) {
  if (appearDelayMs === undefined || result === "open") {
    return (
      <span
        role="img"
        aria-label={labels[result]}
        className={cx("inline-block size-3.5 shrink-0 rounded-sm", fillClasses[result])}
      />
    );
  }
  return (
    <span role="img" aria-label={labels[result]} className="relative inline-block size-3.5 shrink-0 rounded-sm bg-line">
      <AnimatedFill result={result} delayMs={appearDelayMs} />
    </span>
  );
}

function AnimatedFill({ result, delayMs }: { result: SquareResult; delayMs: number }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <MotionProvider>
      <m.span
        className={cx("absolute inset-0 rounded-sm", fillClasses[result])}
        initial={{ opacity: 0, scale: reduce ? 1 : 0.5 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ ...transitions.fade, delay: seconds(delayMs) }}
      />
    </MotionProvider>
  );
}
