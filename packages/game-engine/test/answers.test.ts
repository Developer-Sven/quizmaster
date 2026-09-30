import type { AnswerIndex } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { createCryptoRng } from "../src/crypto-rng.ts";
import { arrangeAnswers, createSeededRng, parseDisplayNumber, type Rng } from "../src/index.ts";

const REPO: [string, string, string, string] = ["Paris", "Lyon", "Marseille", "Nizza"];

/** Chi-Quadrat der Position der richtigen Antwort über `runs` Mischungen (df = 3). */
function correctPositionChiSquare(rng: Rng, runs: number): { chi: number; counts: number[] } {
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < runs; i++) {
    const { correct } = arrangeAnswers(REPO, "shuffle", rng);
    counts[correct] = (counts[correct] ?? 0) + 1;
  }
  const expected = runs / 4;
  const chi = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
  return { chi, counts };
}

describe("arrangeAnswers – Mischung (docs/06 Invariante 2)", () => {
  it("liefert eine Permutation; correct zeigt auf die Repo-Antwort 0", () => {
    const rng = createSeededRng(3);
    for (let i = 0; i < 200; i++) {
      const arranged = arrangeAnswers(REPO, "shuffle", rng);
      expect([...arranged.shownOrder].sort()).toEqual([0, 1, 2, 3]);
      expect(arranged.answers).toEqual(arranged.shownOrder.map((index) => REPO[index]));
      expect(arranged.answers[arranged.correct]).toBe("Paris");
      expect(arranged.shownOrder[arranged.correct]).toBe(0);
    }
  });

  // Schwelle großzügig: df = 3, p ≈ 1,6·10⁻⁵ bei 25 (Soll ~25 % je Position).
  it("Position der richtigen Antwort ist über 10.000 Mischungen gleichverteilt (crypto.randomInt)", () => {
    const { chi, counts } = correctPositionChiSquare(createCryptoRng(), 10_000);
    expect(chi, `Verteilung ${counts.join("/")}`).toBeLessThan(25);
    for (const count of counts) expect(count / 10_000).toBeGreaterThan(0.22);
  });

  it("Position der richtigen Antwort ist über 10.000 Mischungen gleichverteilt (Seed, deterministisch)", () => {
    const { chi } = correctPositionChiSquare(createSeededRng("chi"), 10_000);
    expect(chi).toBeLessThan(25);
  });

  it("die Repo-Reihenfolge (answers[0] richtig) kommt nicht bevorzugt vor", () => {
    const rng = createSeededRng(99);
    let identity = 0;
    for (let i = 0; i < 24_000; i++) {
      if (arrangeAnswers(REPO, "shuffle", rng).shownOrder.join("") === "0123") identity++;
    }
    // 1 von 24 Permutationen ≈ 1.000 – deutlich darüber wäre ein Leak.
    expect(identity).toBeLessThan(1_200);
  });
});

describe("arrangeAnswers – displayOrder asc", () => {
  it("sortiert deutsche Zahlenformate aufsteigend (Tausenderpunkt, Dezimalkomma, Einheit)", () => {
    const rng = createSeededRng(5);
    const answers: [string, string, string, string] = ["7.000", "1.000", "3.000", "10.000"];
    for (let i = 0; i < 50; i++) {
      const arranged = arrangeAnswers(answers, "asc", rng);
      expect(arranged.answers).toEqual(["1.000", "3.000", "7.000", "10.000"]);
      expect(arranged.answers[arranged.correct]).toBe("7.000");
    }
    expect(arrangeAnswers(["1,95583", "1,95538", "1,97583", "2,05583"], "asc", rng).answers).toEqual([
      "1,95538",
      "1,95583",
      "1,97583",
      "2,05583",
    ]);
    expect(arrangeAnswers(["35 mm", "16 mm", "60 mm", "8 mm"], "asc", rng).answers).toEqual([
      "8 mm",
      "16 mm",
      "35 mm",
      "60 mm",
    ]);
    expect(arrangeAnswers(["25 %", "-5 %", "0,5 %", "100 %"], "asc", rng).answers).toEqual([
      "-5 %",
      "0,5 %",
      "25 %",
      "100 %",
    ]);
  });

  it("gleiche Zahlenwerte bleiben in zufälliger Reihenfolge (kein Leak über answers[0])", () => {
    const rng = createSeededRng(8);
    const positions = new Set<AnswerIndex>();
    for (let i = 0; i < 100; i++) {
      positions.add(arrangeAnswers(["1000", "1.000", "5", "9"], "asc", rng).correct);
    }
    expect([...positions].sort()).toEqual([2, 3]);
  });

  it("nicht lesbare Zahlen: natürliche Textsortierung", () => {
    const rng = createSeededRng(9);
    expect(arrangeAnswers(["Jahr 20", "Jahr 3", "Jahr 100", "Jahr 1"], "asc", rng).answers).toEqual([
      "Jahr 1",
      "Jahr 3",
      "Jahr 20",
      "Jahr 100",
    ]);
  });
});

describe("parseDisplayNumber", () => {
  it.each([
    ["1972", 1972],
    ["7.000", 7000],
    ["1.000.000", 1_000_000],
    ["1,95583", 1.95583],
    ["31,1", 31.1],
    ["35 mm", 35],
    ["25 %", 25],
    ["14 Tage", 14],
    ["-5", -5],
    ["−3,5 °C", -3.5],
  ])("%s → %d", (text, value) => {
    expect(parseDisplayNumber(text)).toBeCloseTo(value, 10);
  });

  it("liefert null ohne führende Zahl", () => {
    expect(parseDisplayNumber("Paris")).toBeNull();
    expect(parseDisplayNumber("ca. 5")).toBeNull();
  });
});
