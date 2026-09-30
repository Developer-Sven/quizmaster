import { describe, expect, it } from "vitest";
import { CATEGORY_ICONS, categoryColorStyle, categoryIconFor } from "./category";

/** Icon-Namen aus docs/09 §2 (Quelle content/categories.json). */
const SPEC_ICONS = [
  "book-open",
  "message-circle",
  "gamepad-2",
  "disc-3",
  "leaf",
  "utensils",
  "scroll-text",
  "flask-conical",
  "clapperboard",
  "brain",
  "palette",
  "landmark",
  "star",
  "music",
  "globe",
  "trophy",
  "tv",
  "cog",
  "hourglass",
];

describe("Kategorie-Icons", () => {
  it("bilden genau die 19 Icons aus docs/09 §2 ab", () => {
    expect(Object.keys(CATEGORY_ICONS).sort()).toEqual([...SPEC_ICONS].sort());
    for (const name of SPEC_ICONS) expect(categoryIconFor(name)).not.toBeNull();
  });

  it("liefern für unbekannte Namen kein Icon – auch nicht für Prototyp-Schlüssel", () => {
    expect(categoryIconFor("rocket")).toBeNull();
    expect(categoryIconFor("")).toBeNull();
    expect(categoryIconFor("constructor")).toBeNull();
    expect(categoryIconFor("__proto__")).toBeNull();
  });
});

describe("categoryColorStyle", () => {
  it("setzt gültige Farben als CSS-Variable --cat", () => {
    expect(categoryColorStyle("#EBB447")).toEqual({ "--cat": "#EBB447" });
    expect(categoryColorStyle("#ebb447")).toEqual({ "--cat": "#ebb447" });
  });

  it("verwirft alles, was kein #RRGGBB ist (kein CSS aus Daten)", () => {
    expect(categoryColorStyle("red")).toBeUndefined();
    expect(categoryColorStyle("#fff")).toBeUndefined();
    expect(categoryColorStyle("#EBB447; background: url(x)")).toBeUndefined();
    expect(categoryColorStyle("var(--color-primary)")).toBeUndefined();
  });
});
