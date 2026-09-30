"use client";

import { domAnimation, LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/**
 * motion mit `LazyMotion` + `domAnimation` (docs/03, docs/09 §8). Komponenten nutzen `m.*` aus
 * `motion/react-m` und hüllen sich selbst hierin ein; `reducedMotion="user"` schaltet Transform-
 * Animationen bei `prefers-reduced-motion` ab (Überblendungen bleiben).
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
