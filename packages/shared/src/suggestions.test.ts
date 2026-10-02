import { describe, expect, it } from "vitest";
import { settingsSuggestionSchema } from "./schemas.ts";
import {
  applySettingsUpdate,
  DEFAULT_LOBBY_SETTINGS,
  lobbySettingsSchema,
  SUGGESTABLE_SETTINGS,
  settingsChangesBetween,
  settingsChangesSchema,
  updateSettingsPayloadSchema,
} from "./settings.ts";

describe("Vorschläge für die Einstellungen (ADR-053)", () => {
  it("sind standardmäßig erlaubt – auch in Einstellungen von vorher", () => {
    expect(DEFAULT_LOBBY_SETTINGS.allowSuggestions).toBe(true);
    const before = Object.fromEntries(
      Object.entries(DEFAULT_LOBBY_SETTINGS).filter(([key]) => key !== "allowSuggestions"),
    );
    expect(lobbySettingsSchema.parse(before).allowSuggestions).toBe(true);
  });

  it("nur der Host schaltet sie: allowSuggestions gehört zu Änderungen, nie zu Vorschlägen", () => {
    expect(updateSettingsPayloadSchema.safeParse({ allowSuggestions: false }).success).toBe(true);
    expect(applySettingsUpdate(DEFAULT_LOBBY_SETTINGS, { allowSuggestions: false }).allowSuggestions).toBe(false);
    expect(applySettingsUpdate(DEFAULT_LOBBY_SETTINGS, { rounds: 5 }).allowSuggestions).toBe(true);
    expect(settingsChangesSchema.safeParse({ allowSuggestions: false }).success).toBe(false);
    expect(settingsChangesSchema.safeParse({}).success).toBe(false);
    expect(settingsChangesSchema.safeParse({ rounds: 5, categoryIds: null }).success).toBe(true);
  });

  it("vorschlagbar ist jede Einstellung außer allowSuggestions", () => {
    expect([...SUGGESTABLE_SETTINGS].sort()).toEqual(Object.keys(settingsChangesSchema.shape).sort());
    expect(Object.keys(updateSettingsPayloadSchema.shape).sort()).toEqual(
      [...SUGGESTABLE_SETTINGS, "allowSuggestions"].sort(),
    );
  });

  it("settingsChangesBetween: nur Abweichungen, eine Kategorie-Auswahl unabhängig von der Reihenfolge", () => {
    const current = { ...DEFAULT_LOBBY_SETTINGS, categoryIds: ["sport", "musik"] };
    expect(settingsChangesBetween(current, { ...current })).toBeNull();
    expect(settingsChangesBetween(current, { ...current, categoryIds: ["musik", "sport"] })).toBeNull();
    expect(
      settingsChangesBetween(current, { ...current, rounds: 5, categoryIds: null, allowSuggestions: false }),
    ).toEqual({ rounds: 5, categoryIds: null });
    const next = { ...current, categoryIds: ["kunst"] };
    const changes = settingsChangesBetween(current, next);
    expect(changes?.categoryIds).toEqual(["kunst"]);
    expect(changes?.categoryIds).not.toBe(next.categoryIds);
  });

  it("im öffentlichen Zustand: mit Status, nur bekannte Felder (keine guestId)", () => {
    const suggestion = { id: "s1", playerId: "p1", changes: { rounds: 5 }, status: "pending", at: 1 };
    expect(settingsSuggestionSchema.safeParse(suggestion).success).toBe(true);
    expect(settingsSuggestionSchema.safeParse({ ...suggestion, status: "vielleicht" }).success).toBe(false);
    expect(settingsSuggestionSchema.safeParse({ ...suggestion, guestId: "g1" }).success).toBe(false);
    expect(settingsSuggestionSchema.safeParse({ ...suggestion, changes: {} }).success).toBe(false);
  });
});
