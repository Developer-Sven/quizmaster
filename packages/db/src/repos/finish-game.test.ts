import { randomUUID } from "node:crypto";
import type { GameDoc, LobbyDoc } from "@quizmaster/shared/documents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleQuestion } from "../test-support.ts";
import { createTestDatabase, type TestDatabase } from "../testing/index.ts";
import { createRepositories, endedLobbyExpiresAt, gameExpiresAt, type Repositories } from "./index.ts";

let t: TestDatabase;
let repos: Repositories;
const startedAt = new Date("2026-09-30T18:00:00Z");
const endedAt = new Date("2026-09-30T18:12:00Z");
const [mia, ben] = [randomUUID(), randomUUID()];

beforeAll(async () => {
  t = await createTestDatabase({ ensureIndexes: true });
  repos = createRepositories(t.client, t.collections);
  await repos.guests.create(mia, startedAt, "Mia");
  await repos.guests.create(ben, startedAt, "Ben");
  await t.collections.questions.insertMany([sampleQuestion("co-game0001"), sampleQuestion("co-game0002")]);
});

afterAll(async () => {
  await t?.cleanup();
});

function players(): LobbyDoc["players"] {
  return [
    {
      playerId: "p1",
      guestId: mia,
      name: "Mia",
      color: "blue",
      isBot: false,
      joinedAt: startedAt,
      status: "active",
      score: 2,
    },
    {
      playerId: "p2",
      guestId: ben,
      name: "Ben",
      color: "sky",
      isBot: false,
      joinedAt: startedAt,
      status: "active",
      score: 1,
    },
  ];
}

function game(id: string): GameDoc {
  return {
    _id: id,
    lobbyId: "lobby_fin",
    code: "FNX234",
    startedAt,
    endedAt,
    expiresAt: gameExpiresAt(endedAt),
    settings: { rounds: 1, questionsPerCategory: 2, maxPlayers: 8 },
    outcome: "win",
    players: [
      { playerId: "p1", guestId: mia, name: "Mia", color: "blue", isBot: false, place: 1, score: 2, status: "active" },
      { playerId: "p2", guestId: ben, name: "Ben", color: "sky", isBot: false, place: 2, score: 1, status: "active" },
    ],
    turns: [
      {
        round: 1,
        pickerId: "p1",
        offered: ["comics", "kinofilme", "musik-hits"],
        categoryId: "comics",
        pickedBy: "player",
        questions: [
          {
            questionId: "co-game0001",
            shownOrder: [2, 0, 3, 1],
            answers: [
              { playerId: "p1", choice: 1, ms: 3_000, correct: true },
              { playerId: "p2", choice: 1, ms: 4_000, correct: true },
            ],
          },
          {
            questionId: "co-game0002",
            shownOrder: [0, 1, 2, 3],
            answers: [
              { playerId: "p1", choice: 0, ms: 2_000, correct: true },
              { playerId: "p2", choice: null, ms: null, correct: false },
            ],
          },
        ],
      },
    ],
  };
}

function lobby(rev: number): LobbyDoc {
  return {
    _id: "lobby_fin",
    code: "FNX234",
    active: true,
    phase: "game_over",
    rev,
    settings: { rounds: 1, questionsPerCategory: 2, maxPlayers: 8 },
    createdByGuestId: mia,
    hostPlayerId: "p1",
    players: players(),
    bannedGuestIds: [],
    game: { phase: "game_over" },
    createdAt: startedAt,
    updatedAt: endedAt,
    expiresAt: endedLobbyExpiresAt(endedAt),
  };
}

const input = (gameId: string, rev: number) => ({
  game: game(gameId),
  lobby: lobby(rev),
  guests: [
    {
      guestId: mia,
      questionIds: ["co-game0001", "co-game0002"],
      stats: { games: 1, wins: 1, draws: 0, answers: 2, correct: 2 },
    },
    {
      guestId: ben,
      questionIds: ["co-game0001", "co-game0002"],
      stats: { games: 1, wins: 0, draws: 0, answers: 1, correct: 1 },
    },
  ],
  questionStats: [
    { questionId: "co-game0001", shown: 2, correct: 2 },
    { questionId: "co-game0002", shown: 2, correct: 1 },
  ],
});

describe("finishGame (Transaktion)", () => {
  it("schreibt games, lobbies, guests und Fragen-Statistik gemeinsam", async () => {
    const result = await repos.finishGame(input("game_1", 10), endedAt);
    expect(result).toEqual({ guestsUpdated: 2, questionsUpdated: 2 });
    expect(await t.collections.games.countDocuments({ _id: "game_1" })).toBe(1);
    expect((await t.collections.lobbies.findOne({ _id: "lobby_fin" }))?.rev).toBe(10);
    const guest = await t.collections.guests.findOne({ _id: mia });
    expect(guest?.stats).toEqual({ games: 1, wins: 1, draws: 0, answers: 2, correct: 2 });
    expect(guest?.recentQuestionIds).toEqual(["co-game0001", "co-game0002"]);
    expect((await t.collections.questions.findOne({ _id: "co-game0002" }))?.stats).toMatchObject({
      shown: 2,
      correct: 1,
    });
    expect((await repos.games.listByGuest(ben)).map((g) => g._id)).toEqual(["game_1"]);
  });

  it("rollt bei einem Fehler alles zurück (doppelte Spiel-ID)", async () => {
    await expect(repos.finishGame(input("game_1", 11), endedAt)).rejects.toMatchObject({ code: 11000 });
    expect((await t.collections.lobbies.findOne({ _id: "lobby_fin" }))?.rev).toBe(10);
    expect((await t.collections.guests.findOne({ _id: mia }))?.stats.games).toBe(1);
    expect((await t.collections.questions.findOne({ _id: "co-game0001" }))?.stats.shown).toBe(2);
  });

  it("prüft die Eingaben vor dem Schreiben (zod)", async () => {
    const broken = {
      ...input("game_2", 12),
      guests: [{ guestId: "bot:1", questionIds: [], stats: { games: 1, wins: 0, draws: 0, answers: 0, correct: 0 } }],
    };
    await expect(repos.finishGame(broken, endedAt)).rejects.toThrow();
    expect(await t.collections.games.countDocuments({ _id: "game_2" })).toBe(0);
  });
});
