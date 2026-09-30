import { describe, expect, it } from "vitest";
import { answerIndexForKey, categoryIndexForKey } from "./shortcuts";

describe("Tastenkürzel (docs/09 §12)", () => {
  it("übersetzt 1–4 und A–D in Antworten", () => {
    expect(["1", "2", "3", "4"].map((key) => answerIndexForKey({ key }))).toEqual([0, 1, 2, 3]);
    expect(["a", "B", "c", "D"].map((key) => answerIndexForKey({ key }))).toEqual([0, 1, 2, 3]);
    expect(answerIndexForKey({ key: "5" })).toBeNull();
    expect(answerIndexForKey({ key: "e" })).toBeNull();
  });

  it("übersetzt 1–3 in Kategorien", () => {
    expect(["1", "2", "3"].map((key) => categoryIndexForKey({ key }))).toEqual([0, 1, 2]);
    expect(categoryIndexForKey({ key: "4" })).toBeNull();
    expect(categoryIndexForKey({ key: "a" })).toBeNull();
  });

  it("ignoriert Tasten mit Modifikatoren und Prototyp-Schlüssel", () => {
    expect(answerIndexForKey({ key: "1", ctrlKey: true })).toBeNull();
    expect(answerIndexForKey({ key: "a", metaKey: true })).toBeNull();
    expect(answerIndexForKey({ key: "constructor" })).toBeNull();
  });
});
