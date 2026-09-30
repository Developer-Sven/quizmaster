import { describe, expect, it } from "vitest";
import { nextTrapIndex } from "./focus";

describe("nextTrapIndex (Fokusfalle)", () => {
  it("springt vorwärts und vom letzten Element zum ersten", () => {
    expect(nextTrapIndex(0, 3, false)).toBe(1);
    expect(nextTrapIndex(2, 3, false)).toBe(0);
  });

  it("springt rückwärts und vom ersten Element zum letzten", () => {
    expect(nextTrapIndex(1, 3, true)).toBe(0);
    expect(nextTrapIndex(0, 3, true)).toBe(2);
  });

  it("holt den Fokus von außen an den Rand zurück", () => {
    expect(nextTrapIndex(-1, 3, false)).toBe(0);
    expect(nextTrapIndex(-1, 3, true)).toBe(2);
  });

  it("meldet -1 ohne fokussierbare Elemente", () => {
    expect(nextTrapIndex(0, 0, false)).toBe(-1);
  });
});
