/**
 * ScorePill – „+1“ (docs/09 §8 „Punkte +1“: y 0 → −16, opacity 1 → 0, 480 ms) und Bewegungsreduktion
 * (docs/09 §7: alle Bewegungen werden zu Überblendungen von höchstens 200 ms).
 */
import { describe, expect, it } from "vitest";
import { DURATION_MS, EASING } from "../../lib/ui/tokens";
import { gainMotion } from "./score-pill";

describe("ScorePill: „+1“", () => {
  it("steigt normal 16 px und blendet in 480 ms aus", () => {
    const motion = gainMotion(false);
    expect(motion.initial).toEqual({ opacity: 1, y: 0 });
    expect(motion.animate).toEqual({ opacity: 0, y: -16 });
    expect(motion.transition.duration).toBe(DURATION_MS.overlay / 1000);
    expect(motion.transition.ease).toEqual(EASING.standard);
  });

  it("blendet bei reduzierter Bewegung nur über – ohne Weg, höchstens 200 ms", () => {
    const motion = gainMotion(true);
    expect(motion.initial).toEqual({ opacity: 1, y: 0 });
    expect(motion.animate).toEqual({ opacity: 0, y: 0 });
    expect(motion.transition.duration).toBeLessThanOrEqual(0.2);
    expect(motion.transition.duration * 1000).toBe(DURATION_MS.base);
  });
});
