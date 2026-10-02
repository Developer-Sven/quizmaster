import { describe, expect, it } from "vitest";
import {
  ADVANCE_SECONDS,
  ANSWER_SECONDS,
  advanceDurationMs,
  answerWindowMs,
  applySettingsUpdate,
  DEFAULT_LOBBY_SETTINGS,
  GAME_RULES,
  lobbySettingsSchema,
  MANUAL_ANSWER_CAP_MS,
  SETTINGS_BOUNDS,
  updateSettingsPayloadSchema,
} from "./settings.ts";
import { GAME_TIMING_MODES, getTimings, LOBBY_LIFETIME, questionLeadInMs, TIMINGS, type Timings } from "./timings.ts";

describe("Timings (docs/05 §Timings)", () => {
  it("entspricht der Tabelle für normal und fast", () => {
    const expected: Record<keyof Timings, [normal: number, fast: number]> = {
      introMs: [5_000, 300],
      categoryPickMs: [15_000, 1_500],
      leadInFirstQuestionMs: [3_000, 150],
      leadInNextQuestionMs: [1_500, 100],
      answerMs: [20_000, 2_000],
      deadlineGraceMs: [250, 250],
      earlyRevealMs: [700, 50],
      revealMs: [5_000, 300],
      turnSummaryMs: [5_000, 300],
      roundBoardMs: [7_000, 300],
      gameOverMs: [6_000, 5_000],
      reconnectLobbyMs: [30_000, 2_000],
      reconnectGameMs: [90_000, 5_000],
      hostHandoverMs: [30_000, 2_000],
      emptyLobbyCloseMs: [60_000, 2_000],
    };
    for (const [key, [normal, fast]] of Object.entries(expected) as [keyof Timings, [number, number]][]) {
      expect(TIMINGS.normal[key], key).toBe(normal);
      expect(TIMINGS.fast[key], key).toBe(fast);
    }
    expect(Object.keys(TIMINGS.normal).sort()).toEqual(Object.keys(expected).sort());
  });

  it("liefert je Modus die passenden Werte", () => {
    expect(GAME_TIMING_MODES).toEqual(["normal", "fast"]);
    expect(getTimings("normal")).toBe(TIMINGS.normal);
    expect(getTimings("fast").answerMs).toBe(2_000);
  });

  it("berechnet den Vorlauf je Frage im Zug", () => {
    expect(questionLeadInMs(TIMINGS.normal, 1)).toBe(3_000);
    expect(questionLeadInMs(TIMINGS.normal, 2)).toBe(1_500);
    expect(questionLeadInMs(TIMINGS.fast, 3)).toBe(100);
  });

  it("hält Lobbys 30 min ohne Aktivität und 2 h nach Spielende", () => {
    expect(LOBBY_LIFETIME).toEqual({ idleCloseMs: 1_800_000, afterGameCloseMs: 7_200_000 });
  });
});

describe("Einstellungen (docs/01 §Einstellungen)", () => {
  it("hat die Grenzen und Standards aus docs/01", () => {
    expect(SETTINGS_BOUNDS).toEqual({
      rounds: { min: 1, max: 10, default: 3 },
      questionsPerCategory: { min: 1, max: 10, default: 3 },
      maxPlayers: { min: 2, max: 8, default: 8 },
    });
    expect(DEFAULT_LOBBY_SETTINGS).toEqual({
      rounds: 3,
      questionsPerCategory: 3,
      maxPlayers: 8,
      afterQuestionSec: 5,
      afterTurnSec: 5,
      afterRoundSec: 7,
      hostPlays: true,
      categoryIds: null,
      answerSec: 20,
      allowSuggestions: true,
    });
    expect(Object.isFrozen(DEFAULT_LOBBY_SETTINGS)).toBe(true);
  });

  it("hat die festen Werte wie beim Vorbild – passend zu den Timings", () => {
    expect(GAME_RULES.answersPerQuestion).toBe(4);
    expect(GAME_RULES.categoryOptionsPerTurn).toBe(3);
    expect(GAME_RULES.answerTimeMs).toBe(20_000);
    expect(GAME_RULES.categoryPickTimeMs).toBe(15_000);
    expect(GAME_RULES.pointsPerCorrectAnswer).toBe(1);
    expect(GAME_RULES.answerTimeMs).toBe(TIMINGS.normal.answerMs);
    expect(GAME_RULES.categoryPickTimeMs).toBe(TIMINGS.normal.categoryPickMs);
    expect(GAME_RULES.maxPlayersPerLobby).toBe(8);
  });

  it("validiert lobby:update-settings (nur geänderte Felder, mindestens eines)", () => {
    expect(updateSettingsPayloadSchema.parse({ rounds: 5 })).toEqual({ rounds: 5 });
    expect(updateSettingsPayloadSchema.parse({ questionsPerCategory: 1, maxPlayers: 2 })).toEqual({
      questionsPerCategory: 1,
      maxPlayers: 2,
    });
    for (const bad of [
      {},
      { rounds: 0 },
      { rounds: 11 },
      { rounds: 2.5 },
      { rounds: "3" },
      { maxPlayers: 1 },
      { maxPlayers: 9 },
      { questionsPerCategory: 11 },
      { rounds: 3, extra: true },
      null,
    ]) {
      expect(updateSettingsPayloadSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("wendet Änderungen an", () => {
    expect(applySettingsUpdate(DEFAULT_LOBBY_SETTINGS, { maxPlayers: 4, afterRoundSec: 0 })).toEqual({
      ...DEFAULT_LOBBY_SETTINGS,
      maxPlayers: 4,
      afterRoundSec: 0,
    });
    expect(lobbySettingsSchema.safeParse({ rounds: 3, questionsPerCategory: 3 }).success).toBe(false);
  });

  it("Zeit pro Frage: 10–60 s oder „Host“ (0 = der Host löst auf, ADR-049)", () => {
    expect(ANSWER_SECONDS).toEqual([0, 10, 15, 20, 30, 45, 60]);
    expect(DEFAULT_LOBBY_SETTINGS.answerSec).toBe(20);
    expect(updateSettingsPayloadSchema.parse({ answerSec: 0 })).toEqual({ answerSec: 0 });
    expect(updateSettingsPayloadSchema.parse({ answerSec: 45 })).toEqual({ answerSec: 45 });
    for (const bad of [{ answerSec: 5 }, { answerSec: 25 }, { answerSec: 61 }, { answerSec: -1 }]) {
      expect(updateSettingsPayloadSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(answerWindowMs(DEFAULT_LOBBY_SETTINGS)).toBe(20_000);
    expect(answerWindowMs({ ...DEFAULT_LOBBY_SETTINGS, answerSec: 45 })).toBe(45_000);
    expect(answerWindowMs({ ...DEFAULT_LOBBY_SETTINGS, answerSec: 0 })).toBeNull();
    expect(MANUAL_ANSWER_CAP_MS).toBe(10 * 60_000);
  });

  it("Anzeige-Modus (ADR-046) und Kategorien begrenzen (ADR-048)", () => {
    expect(updateSettingsPayloadSchema.parse({ hostPlays: false })).toEqual({ hostPlays: false });
    expect(updateSettingsPayloadSchema.parse({ categoryIds: ["kunst-kultur"] })).toEqual({
      categoryIds: ["kunst-kultur"],
    });
    // null = alle Kategorien (zurücksetzen).
    expect(updateSettingsPayloadSchema.parse({ categoryIds: null })).toEqual({ categoryIds: null });
    for (const bad of [
      { hostPlays: "nein" },
      { categoryIds: [] },
      { categoryIds: ["kunst-kultur", "kunst-kultur"] },
      { categoryIds: ["Kunst"] },
      { categoryIds: Array.from({ length: 51 }, (_, index) => `kategorie-${index}`) },
    ]) {
      expect(updateSettingsPayloadSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
    expect(applySettingsUpdate(DEFAULT_LOBBY_SETTINGS, { categoryIds: ["sport"] }).categoryIds).toEqual(["sport"]);
    expect(
      applySettingsUpdate({ ...DEFAULT_LOBBY_SETTINGS, categoryIds: ["sport"] }, { categoryIds: null }).categoryIds,
    ).toBeNull();
    expect(
      applySettingsUpdate({ ...DEFAULT_LOBBY_SETTINGS, categoryIds: ["sport"] }, { rounds: 2 }).categoryIds,
    ).toEqual(["sport"]);
  });

  it("Weiter nach Frage, Kategorie und Zwischenstand: 0 = Host tippt „Weiter“, sonst feste Sekundenstufen (ADR-045)", () => {
    expect(ADVANCE_SECONDS).toEqual([0, 3, 5, 7, 10, 15, 20, 30]);
    expect(updateSettingsPayloadSchema.parse({ afterQuestionSec: 0 })).toEqual({ afterQuestionSec: 0 });
    expect(updateSettingsPayloadSchema.parse({ afterTurnSec: 15, afterRoundSec: 30 })).toEqual({
      afterTurnSec: 15,
      afterRoundSec: 30,
    });
    for (const bad of [{ afterQuestionSec: 4 }, { afterTurnSec: -1 }, { afterRoundSec: 31 }, { afterRoundSec: 2.5 }]) {
      expect(updateSettingsPayloadSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // Ältere Snapshots und Server-Zustände ohne die Felder → Standardwerte (Deploy, Wiederaufnahme).
    expect(lobbySettingsSchema.parse({ rounds: 2, questionsPerCategory: 1, maxPlayers: 4 })).toEqual({
      rounds: 2,
      questionsPerCategory: 1,
      maxPlayers: 4,
      afterQuestionSec: 5,
      afterTurnSec: 5,
      afterRoundSec: 7,
      hostPlays: true,
      categoryIds: null,
      answerSec: 20,
      allowSuggestions: true,
    });
    expect(advanceDurationMs(DEFAULT_LOBBY_SETTINGS, "reveal")).toBe(5_000);
    expect(advanceDurationMs({ ...DEFAULT_LOBBY_SETTINGS, afterTurnSec: 0 }, "turn_summary")).toBeNull();
    expect(advanceDurationMs({ ...DEFAULT_LOBBY_SETTINGS, afterRoundSec: 20 }, "round_board")).toBe(20_000);
  });
});
