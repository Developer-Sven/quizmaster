/**
 * games (docs/04): abgeschlossene Spiele (TTL 90 Tage). Geschrieben wird im Spielabschluss
 * (`finishGame`, Transaktion); gelesen nur für Verlauf/Statistik (Backlog, Index
 * `players.guestId + endedAt`).
 */
import { type GameDoc, gameDocSchema, ownerGuestIdSchema, RETENTION } from "@quizmaster/shared/documents";
import type { ClientSession, Collection } from "mongodb";

/** Höchstzahl je Verlaufsabfrage. */
export const GAME_HISTORY_MAX = 50;

export function gameExpiresAt(endedAt: Date): Date {
  return new Date(endedAt.getTime() + RETENTION.gameMs);
}

export interface GamesRepo {
  insert(game: GameDoc, session?: ClientSession): Promise<void>;
  /** Letzte Spiele eines Gasts, neueste zuerst (höchstens `GAME_HISTORY_MAX`). */
  listByGuest(guestId: string, limit?: number): Promise<GameDoc[]>;
}

export function createGamesRepo(games: Collection<GameDoc>): GamesRepo {
  return {
    async insert(game, session) {
      await games.insertOne(gameDocSchema.parse(game), { session });
    },

    async listByGuest(guestId, limit = 20) {
      const capped = Math.max(1, Math.min(GAME_HISTORY_MAX, Math.trunc(limit)));
      return games
        .find({ "players.guestId": ownerGuestIdSchema.parse(guestId) })
        .sort({ endedAt: -1 })
        .limit(capped)
        .toArray();
    },
  };
}
