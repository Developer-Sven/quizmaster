import { describe, expect, it } from "vitest";
import { settingsSuggestionSchema } from "./schemas.ts";
import {
  applySettingsUpdate,
  DEFAULT_LOBBY_SETTINGS,
  lobbySettingsSchema,
  SUGGESTABLE_SETTINGS,
  sameSettingValue,
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

  it("settingsChangesBetween: der Reihe nach (ADR-056) zählt die Reihenfolge der Kategorien", () => {
    const sequence = { ...DEFAULT_LOBBY_SETTINGS, categoryIds: ["sport", "musik"], categoryMode: "sequence" as const };
    // Runde 1 spielt die erste Kategorie – nur die Reihenfolge zu ändern ist hier eine Änderung.
    expect(settingsChangesBetween(sequence, { ...sequence, categoryIds: ["musik", "sport"] })).toEqual({
      categoryIds: ["musik", "sport"],
    });
    // Zusammen mit einer anderen Änderung fällt die Reihenfolge nicht still weg.
    expect(settingsChangesBetween(sequence, { ...sequence, categoryIds: ["musik", "sport"], answerSec: 10 })).toEqual({
      categoryIds: ["musik", "sport"],
      answerSec: 10,
    });
    // Wechsel zu „der Reihe nach“: die vorgeschlagene Reihenfolge gehört dazu.
    const pick = { ...sequence, categoryMode: "pick" as const };
    expect(
      settingsChangesBetween(pick, { ...pick, categoryMode: "sequence", categoryIds: ["musik", "sport"] }),
    ).toEqual({ categoryMode: "sequence", categoryIds: ["musik", "sport"] });
    // Zurück zur Wahl: Die Reihenfolge spielt keine Rolle mehr.
    expect(
      settingsChangesBetween(sequence, { ...sequence, categoryMode: "pick", categoryIds: ["musik", "sport"] }),
    ).toEqual({ categoryMode: "pick" });
  });

  it("sameSettingValue: Auswahl mengengleich, mit `ordered` reihenfolgesensitiv", () => {
    expect(sameSettingValue(["sport", "musik"], ["musik", "sport"])).toBe(true);
    expect(sameSettingValue(["sport", "musik"], ["musik", "sport"], true)).toBe(false);
    expect(sameSettingValue(["sport", "musik"], ["sport", "musik"], true)).toBe(true);
    expect(sameSettingValue(["sport", "musik"], ["sport"], true)).toBe(false);
    expect(sameSettingValue(["sport"], null, true)).toBe(false);
    expect(sameSettingValue(5, 5, true)).toBe(true);
  });

  it("im öffentlichen Zustand: mit Status, nur bekannte Felder (keine guestId)", () => {
    const suggestion = { id: "s1", playerId: "p1", changes: { rounds: 5 }, status: "pending", at: 1 };
    expect(settingsSuggestionSchema.safeParse(suggestion).success).toBe(true);
    expect(settingsSuggestionSchema.safeParse({ ...suggestion, status: "vielleicht" }).success).toBe(false);
    expect(settingsSuggestionSchema.safeParse({ ...suggestion, guestId: "g1" }).success).toBe(false);
    expect(settingsSuggestionSchema.safeParse({ ...suggestion, changes: {} }).success).toBe(false);
  });
});
