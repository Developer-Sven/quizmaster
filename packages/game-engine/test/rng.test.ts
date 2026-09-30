import { describe, expect, it } from "vitest";
import { createCryptoRng } from "../src/crypto-rng.ts";
import {
  chance,
  createSeededRng,
  pickOne,
  RANDOM_ID_ALPHABET,
  RNG_MAX_RANGE,
  randomId,
  shuffle,
  uniqueRandomId,
  weightedIndex,
} from "../src/index.ts";

/** Chi-Quadrat-Statistik beobachteter Häufigkeiten gegen Gleichverteilung. */
function chiSquareUniform(counts: readonly number[]): number {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const expected = total / counts.length;
  return counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
}

describe("createSeededRng", () => {
  it("ist deterministisch je Seed und unterscheidet Seeds", () => {
    const draw = (seed: number | string) => {
      const rng = createSeededRng(seed);
      return Array.from({ length: 20 }, () => rng.int(1_000_000));
    };
    expect(draw(42)).toEqual(draw(42));
    expect(draw("lobby-1")).toEqual(draw("lobby-1"));
    expect(draw(42)).not.toEqual(draw(43));
    expect(draw(42)).not.toEqual(draw("42"));
  });

  it("liefert ganze Zahlen im Bereich [0, max) – auch an den Grenzen", () => {
    const rng = createSeededRng(1);
    for (const max of [1, 2, 3, 7, 1_000, 2 ** 31 + 5, RNG_MAX_RANGE]) {
      for (let i = 0; i < 200; i++) {
        const value = rng.int(max);
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(max);
      }
    }
  });

  it("lehnt ungültige Obergrenzen ab", () => {
    const rng = createSeededRng(1);
    for (const max of [0, -1, 1.5, Number.NaN, RNG_MAX_RANGE + 1]) {
      expect(() => rng.int(max)).toThrow(RangeError);
    }
  });

  it("ist grob gleichverteilt (Chi-Quadrat, 10 Klassen)", () => {
    const rng = createSeededRng("uniform");
    const counts = Array<number>(10).fill(0);
    for (let i = 0; i < 50_000; i++) {
      const bucket = rng.int(10);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    // df = 9: p = 0,001 bei 27,9 – großzügige Grenze.
    expect(chiSquareUniform(counts)).toBeLessThan(40);
  });
});

describe("createCryptoRng", () => {
  it("liefert Werte im Bereich und prüft die Obergrenze", () => {
    const rng = createCryptoRng();
    for (let i = 0; i < 500; i++) {
      const value = rng.int(4);
      expect([0, 1, 2, 3]).toContain(value);
    }
    expect(() => rng.int(0)).toThrow(RangeError);
    expect(() => rng.int(2 ** 40)).toThrow(RangeError);
  });
});

describe("Hilfen", () => {
  it("shuffle liefert eine Permutation und lässt die Eingabe unverändert", () => {
    const rng = createSeededRng(5);
    const input = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
    const output = shuffle(input, rng);
    expect([...output].sort((a, b) => a - b)).toEqual([...input]);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shuffle([], rng)).toEqual([]);
  });

  it("shuffle ist gleichverteilt über alle 6 Permutationen von 3 Elementen", () => {
    const rng = createSeededRng("perm");
    const counts = new Map<string, number>();
    for (let i = 0; i < 60_000; i++) {
      const key = shuffle(["a", "b", "c"], rng).join("");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    // df = 5: p = 0,001 bei 20,5.
    expect(chiSquareUniform([...counts.values()])).toBeLessThan(30);
  });

  it("pickOne wählt aus der Liste und wirft bei leerer Liste", () => {
    const rng = createSeededRng(9);
    expect(["x", "y"]).toContain(pickOne(["x", "y"], rng));
    expect(() => pickOne([], rng)).toThrow(RangeError);
  });

  it("chance respektiert 0, 1 und Wahrscheinlichkeiten dazwischen", () => {
    const rng = createSeededRng(11);
    expect(chance(0, rng)).toBe(false);
    expect(chance(1, rng)).toBe(true);
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (chance(0.3, rng)) hits++;
    expect(hits / 20_000).toBeGreaterThan(0.28);
    expect(hits / 20_000).toBeLessThan(0.32);
  });

  it("weightedIndex folgt den Gewichten; alle 0 → gleichverteilt; ungültig → Fehler", () => {
    const rng = createSeededRng(13);
    const counts = [0, 0, 0];
    for (let i = 0; i < 30_000; i++) {
      const index = weightedIndex([0.2, 0.5, 0.3], rng);
      counts[index] = (counts[index] ?? 0) + 1;
    }
    expect((counts[0] ?? 0) / 30_000).toBeCloseTo(0.2, 1);
    expect((counts[1] ?? 0) / 30_000).toBeCloseTo(0.5, 1);
    expect(weightedIndex([0, 0], rng)).toBeLessThan(2);
    expect(weightedIndex([0, 1, 0], rng)).toBe(1);
    // Große und winzige Gewichte: kein Überlauf, Gewicht 0 nie gewählt.
    for (let i = 0; i < 1_000; i++) {
      expect(weightedIndex([1e12, 0, 3e12], rng)).not.toBe(1);
      expect(weightedIndex([0, 1e-12], rng)).toBe(1);
    }
    expect(() => weightedIndex([], rng)).toThrow(RangeError);
    expect(() => weightedIndex([-1, 2], rng)).toThrow(RangeError);
  });

  it("randomId nutzt nur das Alphabet und passt zu PUBLIC_ID_REGEX", () => {
    const rng = createSeededRng(17);
    const id = randomId(rng, 32);
    expect(id).toHaveLength(32);
    expect([...id].every((char) => RANDOM_ID_ALPHABET.includes(char))).toBe(true);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(() => randomId(rng, 0)).toThrow(RangeError);
    const taken = new Set([randomId(createSeededRng(1), 4)]);
    expect(taken.has(uniqueRandomId(createSeededRng(1), taken, 4))).toBe(false);
  });
});
