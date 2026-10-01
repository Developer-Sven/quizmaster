/**
 * Übergänge für motion aus den Bewegungs-Tokens (docs/09 §8). Ohne "use client", damit Werte
 * überall importierbar sind; `MotionProvider` liegt in ./motion.tsx.
 */
import { DURATION_MS, EASING, OFFSET_PX, seconds } from "./tokens";

/** Übergänge aus der Bewegungstabelle (docs/09 §8), nur Token-Werte. */
export const transitions = {
  /** Screen/Overlay/Sheet rein: 320 ms emphasized */
  enter: { duration: seconds(DURATION_MS.slow), ease: EASING.emphasized },
  /** Screen/Overlay/Sheet raus: 200 ms exit */
  exit: { duration: seconds(DURATION_MS.base), ease: EASING.exit },
  /** Zustandswechsel und reduzierte Bewegung: Überblendung 200 ms standard */
  fade: { duration: seconds(DURATION_MS.base), ease: EASING.standard },
  /** Punkte +1: 900 ms standard (Spieltempo ADR-044) */
  float: { duration: 0.9, ease: EASING.standard },
  /** Zahl hochzählen: 600 ms standard */
  count: { duration: 0.6, ease: EASING.standard },
} as const;

/** Ein-/Ausblenden eines Panels (Dialog, Toast); bei reduzierter Bewegung nur Deckkraft. */
export function panelMotion(reduce: boolean) {
  return {
    initial: { opacity: 0, y: reduce ? 0 : OFFSET_PX.enter },
    animate: { opacity: 1, y: 0, transition: reduce ? transitions.fade : transitions.enter },
    exit: { opacity: 0, y: reduce ? 0 : OFFSET_PX.exit, transition: reduce ? transitions.fade : transitions.exit },
  };
}

/** Sheet von unten; bei reduzierter Bewegung nur Deckkraft. */
export function sheetMotion(reduce: boolean) {
  return {
    initial: reduce ? { opacity: 0 } : { y: "100%" },
    animate: reduce ? { opacity: 1, transition: transitions.fade } : { y: 0, transition: transitions.enter },
    exit: reduce ? { opacity: 0, transition: transitions.fade } : { y: "100%", transition: transitions.exit },
  };
}

/** Scrim: reine Überblendung. */
export const scrimMotion = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: transitions.fade },
  exit: { opacity: 0, transition: transitions.fade },
} as const;
