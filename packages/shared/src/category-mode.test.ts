import { describe, expect, it } from "vitest";
import { formatGameEstimate, questionCount } from "./duration.ts";
import {
  ANSWER_SECONDS,
  applySettingsUpdate,
  DEFAULT_LOBBY_SETTINGS,
  hasCategoryPick,
  SUGGESTABLE_SETTINGS,
  turnsPerRound,
} from "./settings.ts";

describe("Kategorien der Reihe nach, ein Zug je Runde ohne Wahl (ADR-056)", () => {
  it("nur mit mindestens zwei ausgewählten Kategorien; die Runden folgen deren Anzahl", () => {
    const three = applySettingsUpdate(DEFAULT_LOBBY_SETTINGS, {
      categoryIds: ["sport", "musik", "kunst"],
      categoryMode: "sequence",
      rounds: 7,
    });
    expect(three).toMatchObject({ categoryMode: "sequence", rounds: 3 });
    // Eine Kategorie mehr → eine Runde mehr; Rundenwunsch zählt in diesem Modus nicht.
    expect(applySettingsUpdate(three, { categoryIds: ["sport", "musik", "kunst", "film"] }).rounds).toBe(4);
    expect(applySettingsUpdate(three, { rounds: 9 }).rounds).toBe(3);
    // Unter zwei Kategorien gibt es keine Reihenfolge – zurück zur Wahl.
    expect(applySettingsUpdate(three, { categoryIds: ["sport"] }).categoryMode).toBe("pick");
    expect(applySettingsUpdate(three, { categoryIds: null }).categoryMode).toBe("pick");
    expect(DEFAULT_LOBBY_SETTINGS.categoryMode).toBe("pick");
    expect(SUGGESTABLE_SETTINGS).toContain("categoryMode");
  });

  it("ohne Wahl hat jede Runde genau einen Zug – auch die Schätzung", () => {
    const fixed = { ...DEFAULT_LOBBY_SETTINGS, categoryIds: ["sport"] };
    const sequence = { ...DEFAULT_LOBBY_SETTINGS, categoryIds: ["sport", "musik"], categoryMode: "sequence" as const };
    expect(hasCategoryPick(DEFAULT_LOBBY_SETTINGS)).toBe(true);
    expect(hasCategoryPick({ ...DEFAULT_LOBBY_SETTINGS, categoryIds: ["sport", "musik"] })).toBe(true);
    expect(hasCategoryPick(fixed)).toBe(false);
    expect(hasCategoryPick(sequence)).toBe(false);
    expect(turnsPerRound(4, DEFAULT_LOBBY_SETTINGS)).toBe(4);
    expect(turnsPerRound(4, fixed)).toBe(1);
    // 3 Runden × 1 Zug × 3 Fragen statt × 4 Personen.
    expect(formatGameEstimate(3, 4, 3, fixed)).toMatch(/^9 Fragen · /);
    expect(questionCount(3, 4, 3)).toBe(36);
  });

  it("Zeit pro Frage ab 3 s", () => {
    expect(ANSWER_SECONDS).toEqual([0, 3, 5, 10, 15, 20, 30, 45, 60]);
  });
});
