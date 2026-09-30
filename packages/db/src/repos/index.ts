/**
 * Repositories aller Collections (docs/04). `rateLimits` und `socketioEvents` verwalten ihre
 * Bibliotheken selbst (rate-limiter-flexible bzw. Socket.IO-Mongo-Adapter) – dort gibt es nur die
 * typisierten Collections und die Indizes.
 */
import type { MongoClient } from "mongodb";
import type { Collections } from "../collections.ts";
import { type AppConfigRepo, createAppConfigRepo } from "./app-config.ts";
import { type BansRepo, createBansRepo } from "./bans.ts";
import { type CategoriesRepo, createCategoriesRepo } from "./categories.ts";
import { type FinishGameInput, type FinishGameResult, finishGame } from "./finish-game.ts";
import { createGamesRepo, type GamesRepo } from "./games.ts";
import { createGuestsRepo, type GuestsRepo } from "./guests.ts";
import { createLobbiesRepo, type LobbiesRepo } from "./lobbies.ts";
import { createQuestionsRepo, type QuestionsRepo } from "./questions.ts";
import { createRatingsRepo, type RatingsRepo } from "./ratings.ts";
import { createReportsRepo, type ReportsRepo } from "./reports.ts";

export * from "./app-config.ts";
export * from "./bans.ts";
export * from "./categories.ts";
export * from "./finish-game.ts";
export * from "./games.ts";
export * from "./guests.ts";
export * from "./ids.ts";
export * from "./lobbies.ts";
export * from "./questions.ts";
export * from "./ratings.ts";
export * from "./reports.ts";

export interface Repositories {
  guests: GuestsRepo;
  lobbies: LobbiesRepo;
  games: GamesRepo;
  categories: CategoriesRepo;
  questions: QuestionsRepo;
  reports: ReportsRepo;
  ratings: RatingsRepo;
  bans: BansRepo;
  appConfig: AppConfigRepo;
  /** Spielabschluss als Transaktion (games + lobbies + guests + questions). */
  finishGame(input: FinishGameInput, now: Date): Promise<FinishGameResult>;
}

export function createRepositories(client: MongoClient, collections: Collections): Repositories {
  const questions = createQuestionsRepo(collections.questions);
  return {
    guests: createGuestsRepo(collections.guests),
    lobbies: createLobbiesRepo(collections.lobbies),
    games: createGamesRepo(collections.games),
    categories: createCategoriesRepo(collections.categories),
    questions,
    reports: createReportsRepo(collections.questionReports),
    ratings: createRatingsRepo(collections.questionRatings, questions),
    bans: createBansRepo(collections.bans),
    appConfig: createAppConfigRepo(collections.appConfig),
    finishGame: (input, now) => finishGame(client, collections, input, now),
  };
}
