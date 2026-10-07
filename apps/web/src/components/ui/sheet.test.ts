import { describe, expect, it } from "vitest";
import { sheetScrollTop } from "./sheet";

describe("Sheet: Scrollposition beim Wechsel der Ansicht", () => {
  const change = (patch: Partial<Parameters<typeof sheetScrollTop>[0]>) =>
    sheetScrollTop({
      previousView: "main",
      view: "categories",
      open: true,
      subview: true,
      mainScrollTop: 240,
      ...patch,
    });

  it("Unteransichten beginnen oben – auch wenn die Hauptansicht weit unten stand (z. B. „Alle Kategorien“ sichtbar)", () => {
    expect(change({})).toBe(0);
    expect(change({ previousView: "categories", view: "difficulty" })).toBe(0);
  });

  it("zurück in der Hauptansicht steht sie wieder dort, wo man sie verlassen hat (z. B. bei der Zeile „Kategorien“)", () => {
    expect(change({ previousView: "categories", view: "main", subview: false })).toBe(240);
    expect(change({ previousView: "report", view: "list", subview: false, mainScrollTop: 0 })).toBe(0);
  });

  it("lässt die Position ohne Ansichtswechsel und bei geschlossenem Sheet in Ruhe", () => {
    expect(change({ previousView: "categories", view: "categories" })).toBeNull();
    expect(change({ open: false })).toBeNull();
    expect(change({ previousView: undefined, view: undefined, subview: false })).toBeNull();
  });
});
