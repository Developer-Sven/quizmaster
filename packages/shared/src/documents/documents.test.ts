import { describe, expect, it } from "vitest";
import { ipKey } from "../ip/index.ts";
import {
  APP_CONFIG_ID,
  appConfigDocSchema,
  banDocSchema,
  COLLECTIONS,
  categoryDocSchema,
  defaultAppConfig,
  gameDocSchema,
  guestDocSchema,
  ipKeySchema,
  lobbyDocSchema,
  questionDocSchema,
  questionRatingDocSchema,
  questionRatingId,
  questionReportDocSchema,
  RETENTION,
} from "./index.ts";

const now = new Date("2026-09-30T20:00:00.000Z");
const guestId = "0f8fad5b-d9cb-469f-a165-70867728950e";
const settings = { rounds: 3, questionsPerCategory: 3, maxPlayers: 8 };

const player = {
  playerId: "p1",
  guestId,
  name: "Mia",
  color: "blue",
  isBot: false,
  joinedAt: now,
  status: "active",
  score: 0,
} as const;

describe("DB-Dokumente (docs/04 §Schemas)", () => {
  it("guests", () => {
    const guest = {
      _id: guestId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + RETENTION.guestMs),
      lastName: "Mia",
      stats: { games: 1, wins: 1, draws: 0, answers: 9, correct: 7 },
      recentQuestionIds: ["rw-8f3k2m1q"],
    };
    expect(guestDocSchema.parse(guest)).toEqual(guest);
    expect(guestDocSchema.safeParse({ ...guest, _id: "gast-1" }).success).toBe(false);
    expect(
      guestDocSchema.safeParse({ ...guest, recentQuestionIds: Array<string>(1_001).fill("rw-8f3k2m1q") }).success,
    ).toBe(false);
  });

  it("lobbies (Spieler-Snapshots mit guestId nur im Server)", () => {
    const lobby = {
      _id: "lobby_1",
      code: "ABC234",
      active: true,
      phase: "lobby",
      rev: 3,
      settings,
      createdByGuestId: guestId,
      hostPlayerId: "p1",
      players: [player, { ...player, playerId: "b1", guestId: "bot:b1", name: "Bot 1", isBot: true, color: "sky" }],
      bannedGuestIds: [],
      game: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + RETENTION.activeLobbyMs),
    };
    expect(lobbyDocSchema.safeParse(lobby).success).toBe(true);
    expect(lobbyDocSchema.safeParse({ ...lobby, game: { order: ["p1"], board: [] } }).success).toBe(true);
    expect(lobbyDocSchema.safeParse({ ...lobby, code: "ABC 234" }).success).toBe(false);
    expect(lobbyDocSchema.safeParse({ ...lobby, players: Array.from({ length: 9 }, () => player) }).success).toBe(
      false,
    );
  });

  it("games (Mischung als Permutation)", () => {
    const game = {
      _id: "game_1",
      lobbyId: "lobby_1",
      code: "ABC234",
      startedAt: now,
      endedAt: now,
      expiresAt: new Date(now.getTime() + RETENTION.gameMs),
      settings,
      outcome: "win",
      players: [
        { playerId: "p1", guestId, name: "Mia", color: "blue", isBot: false, place: 1, score: 3, status: "active" },
      ],
      turns: [
        {
          round: 1,
          pickerId: "p1",
          offered: ["rund-um-die-welt", "im-labor", "tv-serien"],
          categoryId: "im-labor",
          pickedBy: "timeout",
          questions: [
            {
              questionId: "il-abcdefgh",
              shownOrder: [2, 0, 3, 1],
              answers: [{ playerId: "p1", choice: 1, ms: 5_300, correct: true }],
            },
          ],
        },
      ],
    };
    expect(gameDocSchema.safeParse(game).success).toBe(true);
    const [turn] = game.turns;
    const [question] = turn?.questions ?? [];
    if (!turn || !question) throw new Error("Testdaten unvollständig");
    const badOrder = { ...game, turns: [{ ...turn, questions: [{ ...question, shownOrder: [0, 0, 1, 2] }] }] };
    expect(gameDocSchema.safeParse(badOrder).success).toBe(false);
  });

  it("categories und questions", () => {
    expect(
      categoryDocSchema.safeParse({
        _id: "im-labor",
        name: "Im Labor",
        icon: "flask-conical",
        color: "#26D9B5",
        order: 8,
        description: "Naturwissenschaften",
        scope: "Chemie",
        notScope: "Technik",
        active: true,
        playableCount: 1_180,
        approvedCount: 0,
        playable: true,
        topics: [{ id: "chemie", name: "Chemie", target: 120, method: "mix" }],
        updatedAt: now,
      }).success,
    ).toBe(true);
    const question = {
      _id: "rw-8f3k2m1q",
      category: "rund-um-die-welt",
      topic: "hauptstaedte",
      difficulty: 1,
      prompt: "Was ist die Hauptstadt von Frankreich?",
      answers: ["Paris", "Lyon", "Marseille", "Nizza"],
      displayOrder: "shuffle",
      explanation: null,
      media: null,
      volatile: false,
      asOf: null,
      source: null,
      status: "unverified",
      autoRetired: null,
      lang: "de",
      contentHash: "a".repeat(64),
      version: 1,
      stats: { shown: 0, correct: 0, likes: 0, dislikes: 0, reports: 0 },
      createdAt: now,
      updatedAt: now,
    };
    expect(questionDocSchema.safeParse(question).success).toBe(true);
    expect(questionDocSchema.safeParse({ ...question, status: "needs_fix" }).success).toBe(false);
    expect(questionDocSchema.safeParse({ ...question, autoRetired: { reason: "reports", at: now } }).success).toBe(
      true,
    );
    expect(questionDocSchema.safeParse({ ...question, contentHash: "xyz" }).success).toBe(false);
  });

  it("questionReports, questionRatings und bans", () => {
    expect(
      questionReportDocSchema.safeParse({
        _id: "r1",
        questionId: "rw-8f3k2m1q",
        reason: "veraltet",
        guestId,
        lobbyCode: "ABC234",
        status: "open",
        createdAt: now,
        expiresAt: new Date(now.getTime() + RETENTION.questionReportMs),
      }).success,
    ).toBe(true);
    const rating = {
      _id: questionRatingId("rw-8f3k2m1q", guestId),
      questionId: "rw-8f3k2m1q",
      value: -1,
      updatedAt: now,
      expiresAt: now,
    };
    expect(rating._id).toBe(`rw-8f3k2m1q:${guestId}`);
    expect(questionRatingDocSchema.safeParse(rating).success).toBe(true);
    expect(questionRatingDocSchema.safeParse({ ...rating, _id: `other:${guestId}` }).success).toBe(false);
    expect(questionRatingDocSchema.safeParse({ ...rating, value: 0 }).success).toBe(false);
    // Herkunft (ADR-058): nur der HMAC-IP-Schlüssel, nie die IP; ältere Dokumente ohne Herkunft bleiben gültig.
    const key = ipKey("203.0.113.7", "x".repeat(32)) ?? "";
    expect(ipKeySchema.safeParse(key).success).toBe(true);
    expect(ipKeySchema.safeParse("203.0.113.7").success).toBe(false);
    expect(questionRatingDocSchema.safeParse({ ...rating, ipKey: key, lobbyCode: "ABC234" }).success).toBe(true);
    expect(questionRatingDocSchema.safeParse({ ...rating, ipKey: "203.0.113.7" }).success).toBe(false);
    const report = {
      _id: "r2",
      questionId: "rw-8f3k2m1q",
      reason: "falsch",
      guestId,
      lobbyCode: "ABC234",
      status: "open",
      createdAt: now,
      expiresAt: now,
    };
    expect(questionReportDocSchema.safeParse({ ...report, ipKey: key }).success).toBe(true);
    expect(questionReportDocSchema.safeParse({ ...report, ipKey: null }).success).toBe(true);
    expect(questionReportDocSchema.safeParse({ ...report, ipKey: "::1" }).success).toBe(false);
    expect(
      banDocSchema.safeParse({ _id: "b1", kind: "ip", value: "hmac", reason: "flood", createdAt: now }).success,
    ).toBe(true);
    expect(banDocSchema.safeParse({ _id: "b1", kind: "user", value: "x", reason: "y", createdAt: now }).success).toBe(
      false,
    );
  });
});

describe("appConfig (docs/04 + ADR-021)", () => {
  it("Startwerte sind gültig und enthalten catalog und blockedTerms", () => {
    const config = defaultAppConfig(now);
    expect(appConfigDocSchema.parse(config)).toEqual(config);
    expect(config).toMatchObject({
      _id: APP_CONFIG_ID,
      lobbyCreationEnabled: true,
      turnstileOnJoin: false,
      maxActiveLobbies: 5_000,
      minClientProtocol: 1,
      catalog: { minPlayable: 100, difficultyMix: { "1": 0.2, "2": 0.3, "3": 0.25, "4": 0.15, "5": 0.1 } },
      blockedTerms: [],
    });
  });

  it("ältere Dokumente ohne catalog/blockedTerms bekommen Defaults – je Lesevorgang eigene Objekte", () => {
    const { catalog: _catalog, blockedTerms: _terms, ...legacy } = defaultAppConfig(now);
    const first = appConfigDocSchema.parse(legacy);
    expect(first.catalog.minPlayable).toBe(100);
    expect(first.blockedTerms).toEqual([]);
    first.blockedTerms.push("mutiert");
    first.catalog.difficultyMix["1"] = 0.9;
    const second = appConfigDocSchema.parse(legacy);
    expect(second.blockedTerms).toEqual([]);
    expect(second.catalog.difficultyMix["1"]).toBe(0.2);
  });

  it("prüft Blocklisten-Begriffe und Wartungstext", () => {
    const config = defaultAppConfig(now);
    expect(appConfigDocSchema.parse({ ...config, blockedTerms: ["  blubb  "] }).blockedTerms).toEqual(["blubb"]);
    expect(appConfigDocSchema.safeParse({ ...config, blockedTerms: ["x"] }).success).toBe(false);
    expect(
      appConfigDocSchema.safeParse({ ...config, maintenance: { enabled: true, message: "x".repeat(201) } }).success,
    ).toBe(false);
    expect(
      appConfigDocSchema.safeParse({ ...config, catalog: { minPlayable: 100, difficultyMix: { "1": 1 } } }).success,
    ).toBe(false);
  });

  it("Collection-Namen und Aufbewahrung entsprechen docs/04", () => {
    expect(Object.values(COLLECTIONS).sort()).toEqual(
      [
        "guests",
        "lobbies",
        "games",
        "categories",
        "questions",
        "questionReports",
        "questionRatings",
        "bans",
        "appConfig",
        "rateLimits",
        "socketioEvents",
      ].sort(),
    );
    const day = 86_400_000;
    expect(RETENTION.guestMs / day).toBe(180);
    expect(RETENTION.gameMs / day).toBe(90);
    expect(RETENTION.questionReportMs / day).toBe(365);
    expect(RETENTION.questionRatingMs / day).toBe(365);
    expect(RETENTION.activeLobbyMs).toBe(30 * 60_000);
    expect(RETENTION.endedLobbyMs).toBe(2 * 3_600_000);
  });
});
