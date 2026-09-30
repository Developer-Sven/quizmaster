/**
 * Typisierte Collections (docs/04 §Collections). Der optionale Präfix trennt parallele Testläufe in
 * derselben Test-Datenbank (ADR-029: `MONGODB_COLLECTION_PREFIX`, nur bei `*_test`-Datenbanken).
 */
import {
  type AppConfigDoc,
  type BanDoc,
  type CategoryDoc,
  COLLECTIONS,
  type GameDoc,
  type GuestDoc,
  type LobbyDoc,
  type QuestionDoc,
  type QuestionRatingDoc,
  type QuestionReportDoc,
} from "@quizmaster/shared/documents";
import type { Collection, Db, Document } from "mongodb";

export type CollectionKey = keyof typeof COLLECTIONS;

/** Alle Collections der App, typisiert mit den zod-Dokumenttypen aus `@quizmaster/shared/documents`. */
export interface Collections {
  guests: Collection<GuestDoc>;
  lobbies: Collection<LobbyDoc>;
  games: Collection<GameDoc>;
  categories: Collection<CategoryDoc>;
  questions: Collection<QuestionDoc>;
  questionReports: Collection<QuestionReportDoc>;
  questionRatings: Collection<QuestionRatingDoc>;
  bans: Collection<BanDoc>;
  appConfig: Collection<AppConfigDoc>;
  /** Verwaltet von rate-limiter-flexible (Mongo-Store). */
  rateLimits: Collection<Document>;
  /** Verwaltet vom Socket.IO-Mongo-Adapter (nur Scale-out). */
  socketioEvents: Collection<Document>;
}

export const COLLECTION_KEYS = Object.keys(COLLECTIONS) as readonly CollectionKey[];

/** Erlaubtes Präfix-Format (wie `MONGODB_COLLECTION_PREFIX` im Env-Schema). */
export const COLLECTION_PREFIX_REGEX = /^[a-z0-9_]{1,24}$/;

/** Datenbanken, in denen Präfixe erlaubt sind (ADR-029). */
export function isTestDatabaseName(dbName: string): boolean {
  return dbName.endsWith("_test");
}

/**
 * Prüft einen Präfix: Format und – ADR-029 – nur in `*_test`-Datenbanken. Wirft bei Verstoß, damit
 * Produktions- oder Dev-Daten nie unter einem Test-Präfix landen.
 */
export function assertCollectionPrefix(dbName: string, prefix: string | undefined): void {
  if (prefix === undefined || prefix === "") return;
  if (!COLLECTION_PREFIX_REGEX.test(prefix)) {
    throw new Error(`Ungültiger Collection-Präfix „${prefix}“ (erlaubt: a–z, 0–9, _; max. 24 Zeichen)`);
  }
  if (!isTestDatabaseName(dbName)) {
    throw new Error(`Collection-Präfixe sind nur in *_test-Datenbanken erlaubt (Datenbank: ${dbName})`);
  }
}

/** Name einer Collection inkl. Präfix. */
export function collectionName(key: CollectionKey, prefix = ""): string {
  return `${prefix}${COLLECTIONS[key]}`;
}

export interface CollectionsOptions {
  /** Präfix für Testläufe (nur `*_test`-Datenbanken). */
  prefix?: string;
}

/** Liefert alle Collections einer Datenbank (optional mit Test-Präfix). */
export function getCollections(db: Db, options: CollectionsOptions = {}): Collections {
  const prefix = options.prefix ?? "";
  assertCollectionPrefix(db.databaseName, prefix);
  const name = (key: CollectionKey) => collectionName(key, prefix);
  return {
    guests: db.collection<GuestDoc>(name("guests")),
    lobbies: db.collection<LobbyDoc>(name("lobbies")),
    games: db.collection<GameDoc>(name("games")),
    categories: db.collection<CategoryDoc>(name("categories")),
    questions: db.collection<QuestionDoc>(name("questions")),
    questionReports: db.collection<QuestionReportDoc>(name("questionReports")),
    questionRatings: db.collection<QuestionRatingDoc>(name("questionRatings")),
    bans: db.collection<BanDoc>(name("bans")),
    appConfig: db.collection<AppConfigDoc>(name("appConfig")),
    rateLimits: db.collection(name("rateLimits")),
    socketioEvents: db.collection(name("socketioEvents")),
  };
}
