import { describe, expect, it } from "vitest";
import {
  applySettingsUpdate,
  DEFAULT_LOBBY_SETTINGS,
  GAME_RULES,
  lobbySettingsSchema,
  SETTINGS_BOUNDS,
  updateSettingsPayloadSchema,
} from "./settings.ts";
import { GAME_TIMING_MODES, getTimings, LOBBY_LIFETIME, questionLeadInMs, TIMINGS, type Timings } from "./timings.ts";

describe("Timings (docs/05 §Timings)", () => {
  it("entspricht der Tabelle für normal und fast", () => {
    const expected: Record<keyof Timings, [normal: number, fast: number]> = {
      introMs: [4_000, 300],
      categoryPickMs: [15_000, 1_500],
      leadInFirstQuestionMs: [2_000, 150],
      leadInNextQuestionMs: [800, 100],
      answerMs: [20_000, 2_000],
      deadlineGraceMs: [250, 250],
      earlyRevealMs: [400, 50],
      revealMs: [3_500, 300],
      turnSummaryMs: [4_000, 300],
      roundBoardMs: [6_000, 300],
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
    expect(questionLeadInMs(TIMINGS.normal, 1)).toBe(2_000);
    expect(questionLeadInMs(TIMINGS.normal, 2)).toBe(800);
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
    expect(DEFAULT_LOBBY_SETTINGS).toEqual({ rounds: 3, questionsPerCategory: 3, maxPlayers: 8 });
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
    expect(applySettingsUpdate(DEFAULT_LOBBY_SETTINGS, { maxPlayers: 4 })).toEqual({
      rounds: 3,
      questionsPerCategory: 3,
      maxPlayers: 4,
    });
    expect(lobbySettingsSchema.safeParse({ rounds: 3, questionsPerCategory: 3 }).success).toBe(false);
  });
});
