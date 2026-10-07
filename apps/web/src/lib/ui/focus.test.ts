import { describe, expect, it } from "vitest";
import { focusTitleOnViewChange, nextTrapIndex, trapRedirectIndex } from "./focus";

describe("focusTitleOnViewChange (Sheet-Unteransichten)", () => {
  it("setzt den Fokus auf den Titel, wenn im offenen Sheet die Ansicht wechselt", () => {
    expect(focusTitleOnViewChange("review", "report", true)).toBe(true);
    expect(focusTitleOnViewChange("report", "review", true)).toBe(true);
  });

  it("zieht den Fokus beim Schließen nicht zurück ins ausblendende Sheet", () => {
    // /dev/ui und die Sheets der Lobby setzen `view` zusammen mit `open={false}` zurück – useModalLayer hat den
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

describe("trapRedirectIndex (Fokusfalle greift nur am Rand ein)", () => {
  it("überlässt Tab innerhalb der Ebene dem Browser – der scrollt das Ziel in den sichtbaren Bereich", () => {
    // „Fragen ansehen“: von „Gute Frage“ der 1. Frage weiter zur 2. – kein eigenes focus({ preventScroll })
    expect(trapRedirectIndex(1, 9, false)).toBeNull();
    expect(trapRedirectIndex(7, 9, false)).toBeNull();
    expect(trapRedirectIndex(1, 9, true)).toBeNull();
    expect(trapRedirectIndex(8, 9, true)).toBeNull();
  });

  it("springt vom letzten Element zum ersten und vom ersten zum letzten", () => {
    expect(trapRedirectIndex(8, 9, false)).toBe(0);
    expect(trapRedirectIndex(0, 9, true)).toBe(8);
  });

  it("holt den Fokus vom Titel bzw. von außen an den Rand", () => {
    expect(trapRedirectIndex(-1, 9, false)).toBe(0);
    expect(trapRedirectIndex(-1, 9, true)).toBe(8);
  });

  it("hält den Fokus bei nur einem Element und meldet -1 ohne fokussierbare Elemente", () => {
    expect(trapRedirectIndex(0, 1, false)).toBe(0);
    expect(trapRedirectIndex(0, 1, true)).toBe(0);
    expect(trapRedirectIndex(-1, 0, false)).toBe(-1);
  });
});
