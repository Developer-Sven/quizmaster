import { describe, expect, it } from "vitest";
import { focusTitleOnViewChange, nextTrapIndex } from "./focus";

describe("focusTitleOnViewChange (Sheet-Unteransichten)", () => {
  it("setzt den Fokus auf den Titel, wenn im offenen Sheet die Ansicht wechselt", () => {
    expect(focusTitleOnViewChange("review", "report", true)).toBe(true);
    expect(focusTitleOnViewChange("report", "review", true)).toBe(true);
  });

  it("zieht den Fokus beim Schließen nicht zurück ins ausblendende Sheet", () => {
    // /dev/ui und W2-Aufrufer setzen `view` zusammen mit `open={false}` zurück – useModalLayer hat den
    // Fokus da schon an den Auslöser gegeben; der Titel verschwindet nach der Exit-Animation (Fokus auf body).
    expect(focusTitleOnViewChange("settings", undefined, false)).toBe(false);
    expect(focusTitleOnViewChange("report", "review", false)).toBe(false);
  });

  it("lässt den Fokus ohne Ansichtswechsel in Ruhe", () => {
    expect(focusTitleOnViewChange("review", "review", true)).toBe(false);
    expect(focusTitleOnViewChange(undefined, undefined, false)).toBe(false);
  });
});

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
