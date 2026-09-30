import { describe, expect, it } from "vitest";
import { generateQuestionIds } from "./ids.ts";
import {
  containsPhrase,
  hasWhitespaceProblem,
  isForbiddenAnswer,
  normalizeText,
  parseLeadingGermanNumber,
  trigrams,
} from "./text.ts";

describe("Text-Normalisierung", () => {
  it("vereinheitlicht Groß-/Kleinschreibung, Satzzeichen und Anführungszeichen", () => {
    expect(normalizeText("Wofür steht „DLC“?")).toBe("wofür steht dlc");
    expect(normalizeText("  Ｐａｒｉｓ  ")).toBe("paris");
    expect(containsPhrase("welche stadt ist paris", "paris")).toBe(true);
    expect(containsPhrase("welche stadt ist parisienne", "paris")).toBe(false);
    expect(trigrams("ab")).toEqual(new Set([" ab", "ab "]));
  });

  it("liest Zahlen im deutschen Format", () => {
    expect(parseLeadingGermanNumber("1.001 PS")).toBe(1001);
    expect(parseLeadingGermanNumber("0,25")).toBe(0.25);
    expect(parseLeadingGermanNumber("75 %")).toBe(75);
    expect(parseLeadingGermanNumber("-3 °C")).toBe(-3);
    expect(parseLeadingGermanNumber("1989")).toBe(1989);
    expect(parseLeadingGermanNumber("ca. 12")).toBeNull();
    expect(parseLeadingGermanNumber("Paris")).toBeNull();
  });

  it("erkennt verbotene Sammelantworten, lässt echte Einzelwörter zu", () => {
    for (const answer of [
      "Alle genannten",
      "Keine davon",
      "Keine der Antworten",
      "Alle Antworten sind richtig",
      "Nichts davon",
      "Alle oben genannten",
    ]) {
      expect(isForbiddenAnswer(answer), answer).toBe(true);
    }
    for (const answer of ["Keine", "Alle", "Keine Monde", "Alle Neune", "Beide Eltern"]) {
      expect(isForbiddenAnswer(answer), answer).toBe(false);
    }
  });

  it("meldet Leerraum-Probleme", () => {
    expect(hasWhitespaceProblem(" Paris")).toBe(true);
    expect(hasWhitespaceProblem("Paris  Nord")).toBe(true);
    expect(hasWhitespaceProblem("Paris Nord")).toBe(false);
  });
});

describe("content:ids", () => {
  it("erzeugt eindeutige IDs mit Kategoriekürzel und meidet vergebene", () => {
    let calls = 0;
    // Erste Ziehung „aaaaaaaa“ (vergeben) → verworfen, zweite „bbbbbbbb“.
    const random = () => (calls++ < 8 ? 0 : 1);
    expect(generateQuestionIds("comics", 1, new Set(["co-aaaaaaaa"]), random)).toEqual(["co-bbbbbbbb"]);
    const ids = generateQuestionIds("rund-um-die-welt", 50, new Set());
    expect(new Set(ids).size).toBe(50);
    expect(ids.every((id) => /^rw-[a-z0-9]{8}$/.test(id))).toBe(true);
    expect(() => generateQuestionIds("comics", 0, new Set())).toThrow(RangeError);
  });
});
