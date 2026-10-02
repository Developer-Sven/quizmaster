import { describe, expect, it } from "vitest";
import {
  estimateDurationSeconds,
  formatDurationEstimate,
  formatGameEstimate,
  questionCount,
  roundDurationMinutes,
} from "./duration.ts";

describe("Dauer-Schätzung (docs/01)", () => {
  it("3 Runden × 4 Personen × 3 Fragen → „36 Fragen · ca. 13 Min.“ (Beispiel docs/01)", () => {
    expect(questionCount(3, 4, 3)).toBe(36);
    expect(estimateDurationSeconds(3, 4, 3)).toBe(806);
    expect(formatGameEstimate(3, 4, 3)).toBe("36 Fragen · ca. 13 Min.");
  });

  it("3 Runden × 3 Personen × 3 Fragen → „27 Fragen · ca. 10 Min.“ (Beispiel docs/09)", () => {
    expect(questionCount(3, 3, 3)).toBe(27);
    expect(estimateDurationSeconds(3, 3, 3)).toBe(611);
    expect(formatGameEstimate(3, 3, 3)).toBe("27 Fragen · ca. 10 Min.");
  });

  it("folgt der Formel 5 + R × (P × (6 + 3 + K × 17 + 5) + 7) – Spieltempo ADR-044", () => {
    for (const [r, p, k] of [
      [1, 2, 1],
      [2, 5, 7],
      [10, 8, 10],
    ] as const) {
      expect(estimateDurationSeconds(r, p, k)).toBe(5 + r * (p * (6 + 3 + k * 17 + 5) + 7));
    }
    expect(questionCount(10, 8, 10)).toBe(800);
    expect(formatGameEstimate(10, 8, 10)).toBe("800 Fragen · ca. 247 Min.");
  });

  it("rundet kaufmännisch auf ganze Minuten, mindestens 1", () => {
    expect(roundDurationMinutes(0)).toBe(1);
    expect(roundDurationMinutes(29)).toBe(1);
    expect(roundDurationMinutes(89)).toBe(1);
    expect(roundDurationMinutes(90)).toBe(2);
    expect(roundDurationMinutes(806)).toBe(13);
    expect(roundDurationMinutes(611)).toBe(10);
    expect(formatDurationEstimate(150)).toBe("ca. 3 Min.");
  });

  it("rechnet mit den Weiter-Einstellungen; „Host tippt Weiter“ zählt wie der Standard (ADR-045)", () => {
    const slow = { afterQuestionSec: 10, afterTurnSec: 10, afterRoundSec: 20 };
    expect(estimateDurationSeconds(3, 3, 3, slow)).toBe(5 + 3 * (3 * (6 + 3 + 3 * (12 + 10) + 10) + 20));
    const manual = { afterQuestionSec: 0, afterTurnSec: 0, afterRoundSec: 0 };
    expect(estimateDurationSeconds(3, 3, 3, manual)).toBe(estimateDurationSeconds(3, 3, 3));
    expect(formatGameEstimate(3, 3, 3, slow)).toBe("27 Fragen · ca. 14 Min.");
  });

  it("rechnet mit der Zeit pro Frage: im Schnitt gut die Hälfte; „Host“ zählt wie 20 s (ADR-049)", () => {
    expect(estimateDurationSeconds(3, 3, 3, { answerSec: 20 })).toBe(estimateDurationSeconds(3, 3, 3));
    expect(estimateDurationSeconds(3, 3, 3, { answerSec: 0 })).toBe(estimateDurationSeconds(3, 3, 3));
    // 60 s: im Schnitt 33 s statt 11 s je Frage → 27 Fragen × 22 s mehr.
    expect(estimateDurationSeconds(3, 3, 3, { answerSec: 60 })).toBe(estimateDurationSeconds(3, 3, 3) + 27 * 22);
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
