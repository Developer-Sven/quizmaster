import { describe, expect, it } from "vitest";
import {
  estimateDurationSeconds,
  formatDurationEstimate,
  formatGameEstimate,
  questionCount,
  roundDurationMinutes,
} from "./duration.ts";

describe("Dauer-Schätzung (docs/01)", () => {
  it("3 Runden × 4 Personen × 3 Fragen → „36 Fragen · ca. 12 Min.“ (Beispiel docs/01)", () => {
    expect(questionCount(3, 4, 3)).toBe(36);
    expect(estimateDurationSeconds(3, 4, 3)).toBe(706);
    expect(formatGameEstimate(3, 4, 3)).toBe("36 Fragen · ca. 12 Min.");
  });

  it("3 Runden × 3 Personen × 3 Fragen → „27 Fragen · ca. 9 Min.“ (Beispiel docs/09)", () => {
    expect(questionCount(3, 3, 3)).toBe(27);
    expect(estimateDurationSeconds(3, 3, 3)).toBe(535);
    expect(formatGameEstimate(3, 3, 3)).toBe("27 Fragen · ca. 9 Min.");
  });

  it("folgt der Formel 4 + R × (P × (6 + 2 + K × 15 + 4) + 6)", () => {
    for (const [r, p, k] of [
      [1, 2, 1],
      [2, 5, 7],
      [10, 8, 10],
    ] as const) {
      expect(estimateDurationSeconds(r, p, k)).toBe(4 + r * (p * (6 + 2 + k * 15 + 4) + 6));
    }
    expect(questionCount(10, 8, 10)).toBe(800);
    expect(formatGameEstimate(10, 8, 10)).toBe("800 Fragen · ca. 217 Min.");
  });

  it("rundet kaufmännisch auf ganze Minuten, mindestens 1", () => {
    expect(roundDurationMinutes(0)).toBe(1);
    expect(roundDurationMinutes(29)).toBe(1);
    expect(roundDurationMinutes(89)).toBe(1);
    expect(roundDurationMinutes(90)).toBe(2);
    expect(roundDurationMinutes(706)).toBe(12);
    expect(roundDurationMinutes(535)).toBe(9);
    expect(formatDurationEstimate(150)).toBe("ca. 3 Min.");
  });

  it("nutzt den Singular bei genau einer Frage", () => {
    expect(formatGameEstimate(1, 1, 1)).toBe("1 Frage · ca. 1 Min.");
  });

  it("wirft bei ungültigen Werten", () => {
    expect(() => questionCount(-1, 2, 3)).toThrow(RangeError);
    expect(() => estimateDurationSeconds(1.5, 2, 3)).toThrow(RangeError);
    expect(() => formatGameEstimate(3, Number.NaN, 3)).toThrow(RangeError);
  });
});
