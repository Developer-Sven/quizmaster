import { describe, expect, it } from "vitest";
import { secondsLeft, TIMER_DANGER_MS, timerAnnouncements, timerState, timerStyle } from "./timer";

describe("timerState", () => {
  it("berechnet Anteil und Verzögerung bis zum roten Bereich", () => {
    expect(timerState(20_000, 20_000)).toEqual({
      remainingMs: 20_000,
      fraction: 1,
      dangerDelayMs: 20_000 - TIMER_DANGER_MS,
      expired: false,
    });
    expect(timerState(10_000, 20_000).fraction).toBe(0.5);
  });

  it("startet in den letzten 5 s sofort rot (negative Verzögerung)", () => {
    expect(timerState(3_000, 20_000).dangerDelayMs).toBe(-2_000);
  });

  it("begrenzt Werte und behandelt ungültige Eingaben als abgelaufen", () => {
    expect(timerState(25_000, 20_000).remainingMs).toBe(20_000);
    expect(timerState(-5, 20_000)).toMatchObject({ remainingMs: 0, fraction: 0, expired: true });
    expect(timerState(Number.NaN, 20_000).expired).toBe(true);
    expect(timerState(5_000, 0).fraction).toBe(1);
  });
});

describe("timerStyle", () => {
  it("liefert die CSS-Variablen der Timer-Utilities", () => {
    expect(timerStyle(timerState(12_000, 20_000))).toEqual({
      "--timer-remaining": "12000ms",
      "--timer-from": "0.6",
      "--timer-danger-delay": "7000ms",
    });
  });
});

describe("secondsLeft", () => {
  it("rundet auf und wird nie negativ", () => {
    expect(secondsLeft(20_000)).toBe(20);
    expect(secondsLeft(4_001)).toBe(5);
    expect(secondsLeft(1)).toBe(1);
    expect(secondsLeft(0)).toBe(0);
    expect(secondsLeft(-300)).toBe(0);
  });
});

describe("timerAnnouncements", () => {
  it("plant Ansagen nur bei 10 und 5 Sekunden, die noch bevorstehen", () => {
    expect(timerAnnouncements(20_000)).toEqual([
      { seconds: 10, delayMs: 10_000 },
      { seconds: 5, delayMs: 15_000 },
    ]);
    expect(timerAnnouncements(7_000)).toEqual([{ seconds: 5, delayMs: 2_000 }]);
    expect(timerAnnouncements(4_000)).toEqual([]);
  });
});
