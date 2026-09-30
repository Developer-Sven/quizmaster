/**
 * Spielabschluss als Transaktion (docs/04 §Fragenauswahl 6, docs/02 §Replica Set): `games` einfügen,
 * Lobby-Snapshot schreiben, je Gast `recentQuestionIds` (`$push` + `$slice: -1000`) und Statistik
 * (`$inc`), Fragen-Statistik per `bulkWrite` (`ordered: false`) – alles oder nichts.
 *
 * `withTransaction` wiederholt die Funktion bei transienten Fehlern; sie ist daher idempotent gebaut
 * (jeder Versuch läuft in einer neuen Transaktion, abgebrochene Versuche hinterlassen nichts).
 */
import { type GameDoc, gameDocSchema, type LobbyDoc, lobbyDocSchema } from "@quizmaster/shared/documents";
import type { MongoClient } from "mongodb";
import type { Collections } from "../collections.ts";
import { type GuestGameResult, guestGameResultSchema, guestGameResultUpdate } from "./guests.ts";
import { chunk } from "./ids.ts";
import { QUESTION_BATCH_SIZE, type QuestionStatsDelta, questionStatsOperations } from "./questions.ts";

export interface FinishGameInput {
  game: GameDoc;
  /** Lobby-Snapshot nach Spielende (Phase `game_over`, neuer `rev`). */
  lobby: LobbyDoc;
  /** Nur menschliche Gäste (UUID) – Dev-Bots haben kein guests-Dokument. */
  guests: readonly GuestGameResult[];
  questionStats: readonly QuestionStatsDelta[];
}

export interface FinishGameResult {
  guestsUpdated: number;
  questionsUpdated: number;
}

export async function finishGame(
  client: MongoClient,
  collections: Collections,
  input: FinishGameInput,
  now: Date,
): Promise<FinishGameResult> {
  const game = gameDocSchema.parse(input.game);
  const lobby = lobbyDocSchema.parse(input.lobby);
  const guestResults = input.guests.map((guest) => guestGameResultSchema.parse(guest));
  const questionOperations = questionStatsOperations(input.questionStats);
  return client.withSession((session) =>
    session.withTransaction(async () => {
      await collections.games.insertOne(game, { session });
      await collections.lobbies.replaceOne({ _id: lobby._id }, lobby, { upsert: true, session });
      let guestsUpdated = 0;
      for (const result of guestResults) {
        const update = await collections.guests.updateOne({ _id: result.guestId }, guestGameResultUpdate(result, now), {
          session,
        });
        guestsUpdated += update.matchedCount;
      }
      let questionsUpdated = 0;
      for (const part of chunk(questionOperations, QUESTION_BATCH_SIZE)) {
        const bulk = await collections.questions.bulkWrite(part, { ordered: false, session });
        questionsUpdated += bulk.matchedCount;
      }
      return { guestsUpdated, questionsUpdated };
    }),
  );
}
