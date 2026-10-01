import { describe, expect, it } from "vitest";
import { parseCategoriesResponse, parseStoredCategories, serializeCategories } from "./categories";

const MUSIC = { id: "musik-hits", name: "Musik & Hits", icon: "music", color: "#5988F8" };
const WORLD = { id: "rund-um-die-welt", name: "Rund um die Welt", icon: "globe", color: "#3F9FF3" };

describe("gespeicherte Kategorien", () => {
  it("überstehen ein Neuladen für dieselbe Lobby", () => {
    const json = serializeCategories("ABC234", { [MUSIC.id]: MUSIC, [WORLD.id]: WORLD });
    expect(parseStoredCategories(json, "ABC234")).toEqual({ [MUSIC.id]: MUSIC, [WORLD.id]: WORLD });
  });

  it("gelten nicht für andere Lobbys und verwerfen Ungültiges", () => {
    const json = serializeCategories("ABC234", { [MUSIC.id]: MUSIC });
    expect(parseStoredCategories(json, "XYZ789")).toEqual({});
    expect(parseStoredCategories("{kaputt", "ABC234")).toEqual({});
    expect(parseStoredCategories(null, "ABC234")).toEqual({});
    const wrongColor = JSON.stringify({ code: "ABC234", categories: { [MUSIC.id]: { ...MUSIC, color: "red" } } });
    expect(parseStoredCategories(wrongColor, "ABC234")).toEqual({});
    const mismatch = JSON.stringify({ code: "ABC234", categories: { comics: MUSIC } });
    expect(parseStoredCategories(mismatch, "ABC234")).toEqual({});
  });
});

describe("GET /api/categories", () => {
  it("übernimmt nur die benötigten Felder", () => {
    expect(parseCategoriesResponse({ categories: [{ ...MUSIC, order: 14 }] })).toEqual([MUSIC]);
  });

  it("liefert bei ungültiger Antwort eine leere Liste", () => {
    expect(parseCategoriesResponse({ categories: [{ id: "x" }] })).toEqual([]);
    expect(parseCategoriesResponse(null)).toEqual([]);
    expect(parseCategoriesResponse([MUSIC])).toEqual([]);
  });
});
