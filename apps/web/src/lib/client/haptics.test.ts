import { afterEach, describe, expect, it, vi } from "vitest";
import { HAPTIC_PATTERNS, hapticPattern, vibrate } from "./haptics";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Haptik (docs/09 §10)", () => {
  it("nutzt die festen Muster: Einloggen 15 ms, richtig [20, 40, 20], falsch 60 ms", () => {
    expect(HAPTIC_PATTERNS).toEqual({ lock: 15, correct: [20, 40, 20], wrong: 60 });
    const pattern = hapticPattern("correct");
    expect(pattern).toEqual([20, 40, 20]);
    expect(pattern).not.toBe(HAPTIC_PATTERNS.correct);
  });

  it("vibriert, wo navigator.vibrate vorhanden ist und schon eine Interaktion war", () => {
    const calls: Array<number | number[]> = [];
    const target = {
      vibrate: (pattern: number | number[]) => {
        calls.push(pattern);
        return true;
      },
      userActivation: { hasBeenActive: true },
    };
    expect(vibrate("lock", target)).toBe(true);
    expect(vibrate("wrong", target)).toBe(true);
    expect(calls).toEqual([15, 60]);
  });

  it("tut ohne API, ohne Interaktion oder ohne Navigator nichts", () => {
    const vibrateSpy = vi.fn(() => true);
    expect(vibrate("lock", {})).toBe(false);
    expect(vibrate("lock", { vibrate: vibrateSpy, userActivation: { hasBeenActive: false } })).toBe(false);
    expect(vibrateSpy).not.toHaveBeenCalled();
    expect(vibrate("lock", undefined)).toBe(false);
  });

  it("meldet eine abgelehnte Vibration einmal und spielt weiter", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = {
      vibrate: () => {
        throw new DOMException("blocked", "NotAllowedError");
      },
    };
    expect(vibrate("correct", target)).toBe(false);
    expect(vibrate("wrong", target)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
