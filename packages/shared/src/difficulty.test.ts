import { describe, expect, it } from "vitest";
import { difficultyRange, spreadDifficulties, turnDifficulty } from "./difficulty.ts";
import {
  ANSWER_SECONDS,
  DEFAULT_LOBBY_SETTINGS,
  lobbySettingsSchema,
  SUGGESTABLE_SETTINGS,
  settingsChangesSchema,
} from "./settings.ts";

describe("Schwierigkeit (ADR-055)", () => {
  it("verteilt aufsteigend gleichmäßig über den Bereich", () => {
    expect(spreadDifficulties(1, 3, 6)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(spreadDifficulties(1, 5, 3)).toEqual([1, 3, 5]);
    expect(spreadDifficulties(1, 3, 4)).toEqual([1, 2, 2, 3]);
    expect(spreadDifficulties(2, 2, 3)).toEqual([2, 2, 2]);
    expect(spreadDifficulties(1, 5, 1)).toEqual([3]);
    expect(spreadDifficulties(1, 5, 0)).toEqual([]);
    expect(difficultyRange(2, 4)).toEqual([2, 3, 4]);
  });

  it("pro Kategorie aufsteigend: von Zug zu Zug schwerer, außerhalb der geplanten Züge begrenzt", () => {
    const levels = [1, 2, 3, 4, 5, 6].map((turn) => turnDifficulty(1, 3, turn, 6));
    expect(levels).toEqual([1, 1, 2, 2, 3, 3]);
    expect(turnDifficulty(1, 5, 9, 6)).toBe(5);
    expect(turnDifficulty(1, 5, 0, 6)).toBe(1);
  });

  it("Einstellungen: alle Stufen, pro Frage, aufsteigend – auch für ältere Zustände; 5 s pro Frage möglich", () => {
    expect(DEFAULT_LOBBY_SETTINGS).toMatchObject({
      difficultyMin: 1,
      difficultyMax: 5,
      difficultyBasis: "question",
      difficultyOrder: "ascending",
    });
    const before = Object.fromEntries(
      Object.entries(DEFAULT_LOBBY_SETTINGS).filter(([key]) => !key.startsWith("difficulty")),
    );
    expect(lobbySettingsSchema.parse(before)).toMatchObject({ difficultyMin: 1, difficultyMax: 5 });
    expect(settingsChangesSchema.safeParse({ difficultyMin: 6 }).success).toBe(false);
    expect(settingsChangesSchema.safeParse({ difficultyBasis: "category", difficultyOrder: "random" }).success).toBe(
      true,
    );
    expect(SUGGESTABLE_SETTINGS).toEqual(expect.arrayContaining(["difficultyMin", "difficultyOrder"]));
    expect(ANSWER_SECONDS).toContain(5);
  });
});
