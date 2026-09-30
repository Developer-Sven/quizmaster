"use client";

import { useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import { CheckIcon, ICON_SIZE, type LucideIcon, XIcon } from "../../lib/ui/icons";
import { MotionProvider } from "../../lib/ui/motion";
import { transitions } from "../../lib/ui/motion-presets";
import type { SquareResult } from "../../lib/ui/results";
import { seconds } from "../../lib/ui/tokens";

/**
 * Flächen nach docs/09 §5. Der transparente 1-px-Rahmen ist im Normalfall unsichtbar (die Fläche liegt
 * darunter), im Kontrastmodus (forced colors) zeichnet der Browser ihn in Textfarbe – Flächenfarben
 * werden dort zu Canvas, das Kästchen bliebe sonst unsichtbar.
 */
const fillClasses: Record<SquareResult, string> = {
  correct: "border border-transparent bg-success text-bg",
  wrong: "border border-transparent bg-danger text-bg",
  open: "border border-transparent bg-line",
  none: "border-2 border-danger bg-danger-tint",
};

/** Richtig/falsch zusätzlich als Glyphe (docs/09 §12): nicht nur über Grün/Rot unterscheidbar (WCAG 1.4.1). */
const glyphs: Partial<Record<SquareResult, LucideIcon>> = {
  correct: CheckIcon,
  wrong: XIcon,
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

/**
 * ResultSquare (docs/09 §5): 14 × 14, `radius-sm`; richtig/falsch zusätzlich per Glyphe (`check`/`x`,
 * 12 px in `bg`) und als Screenreader-Text.
 */
export function ResultSquare({ result, appearDelayMs }: ResultSquareProps) {
  if (appearDelayMs === undefined || result === "open") {
    return (
      <span
        role="img"
        aria-label={labels[result]}
        className={cx("inline-flex items-center justify-center size-3.5 shrink-0 rounded-sm", fillClasses[result])}
      >
        <Glyph result={result} />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={labels[result]}
      className={cx("relative inline-block size-3.5 shrink-0 rounded-sm", fillClasses.open)}
    >
      <AnimatedFill result={result} delayMs={appearDelayMs} />
    </span>
  );
}

function Glyph({ result }: { result: SquareResult }) {
  const Icon = glyphs[result];
  return Icon ? <Icon size={ICON_SIZE.badge} className="shrink-0" /> : null;
}

function AnimatedFill({ result, delayMs }: { result: SquareResult; delayMs: number }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <MotionProvider>
      {/* -inset-px: deckt auch den transparenten Rahmen des äußeren Kästchens ab */}
      <m.span
        className={cx("absolute -inset-px flex items-center justify-center rounded-sm", fillClasses[result])}
        initial={{ opacity: 0, scale: reduce ? 1 : 0.5 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ ...transitions.fade, delay: seconds(delayMs) }}
      >
        <Glyph result={result} />
      </m.span>
    </MotionProvider>
  );
}
