/**
 * Collection-Namen und Aufbewahrungsfristen (docs/04 §Collections). Der Test-Harness in packages/db
 * stellt je Lauf ein Präfix voran (MONGODB_COLLECTION_PREFIX, nur in *_test-Datenbanken).
 */

export const COLLECTIONS = {
  guests: "guests",
  lobbies: "lobbies",
  games: "games",
  categories: "categories",
  questions: "questions",
  questionReports: "questionReports",
  questionRatings: "questionRatings",
  bans: "bans",
  appConfig: "appConfig",
  /** Zähler von rate-limiter-flexible (Mongo-Store, `tableName`). */
  rateLimits: "rateLimits",
  /** Nur bei mehreren Realtime-Instanzen (Socket.IO-Mongo-Adapter). */
  socketioEvents: "socketioEvents",
} as const;
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Aufbewahrung (TTL über `expiresAt`, docs/04). */
export const RETENTION = {
  /** guests: lastSeenAt + 180 Tage. */
  guestMs: 180 * DAY_MS,
  /** games: endedAt + 90 Tage. */
  gameMs: 90 * DAY_MS,
  /** questionReports: createdAt + 365 Tage. */
  questionReportMs: 365 * DAY_MS,
  /** questionRatings: updatedAt + 365 Tage. */
  questionRatingMs: 365 * DAY_MS,
  /** lobbies aktiv: updatedAt + 30 min. */
  activeLobbyMs: 30 * 60 * 1_000,
  /** lobbies beendet: endedAt + 2 h. */
  endedLobbyMs: 2 * 60 * 60 * 1_000,
  /** socketioEvents: 1 h (nur Scale-out). */
  socketioEventSec: 3_600,
} as const;

/** Höchstzahl gemerkter gesehener Fragen je Gast (`$push` + `$slice: -1000`). */
export const RECENT_QUESTION_IDS_MAX = 1_000;
