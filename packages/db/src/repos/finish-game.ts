/**
 * Spielabschluss als Transaktion (docs/04 §Fragenauswahl 6, docs/02 §Replica Set): `games` einfügen,
 * Lobby-Snapshot schreiben, je Gast `recentQuestionIds` (`$push` + `$slice: -1000`) und Statistik
 * (`$inc`), Fragen-Statistik per `bulkWrite` (`ordered: false`) – alles oder nichts.
 *
 * `withTransaction` wiederholt die Funktion bei transienten Fehlern; sie ist daher idempotent gebaut
 * (jeder Versuch läuft in einer neuen Transaktion, abgebrochene Versuche hinterlassen nichts).
 *
 * Der Lobby-Snapshot nutzt denselben Guard wie `lobbies.save`: Steht in der DB ein neuerer Stand oder ist
 * die Lobby schon geschlossen, bleibt sie unverändert (`lobby: "stale"`) – Spiel und Statistik werden
 * trotzdem geschrieben.
 */
import { type GameDoc, gameDocSchema, type LobbyDoc, lobbyDocSchema } from "@quizmaster/shared/documents";
import type { MongoClient } from "mongodb";
import type { Collections } from "../collections.ts";
import { type GuestGameResult, guestGameResultSchema, guestGameResultUpdate } from "./guests.ts";
import { chunk } from "./ids.ts";
import { writeLobbySnapshot } from "./lobbies.ts";
import { QUESTION_BATCH_SIZE, type QuestionStatsDelta, questionStatsOperations } from "./questions.ts";

export interface FinishGameInput {
  game: GameDoc;
  /** Lobby-Snapshot nach Spielende (Phase `game_over`, neuer `rev`). */
  lobby: LobbyDoc;
  /** Nur menschliche Gäste (UUID) – Dev-Bots haben kein guests-Dokument. */
  guests: readonly GuestGameResult[];
  questionStats: readonly QuestionStatsDelta[];
}

/**
 * Frist für den gesamten Spielabschluss inkl. Wiederholungen (Treiber-Standard wären bis zu 120 s): ein
 * hängender Abschluss blockiert sonst die serielle Warteschlange der Lobby (docs/02 LobbyActor).
 */
export const FINISH_GAME_TIMEOUT_MS = 20_000;

export interface FinishGameOptions {
  /** Frist in ms (Standard `FINISH_GAME_TIMEOUT_MS`); danach wird abgebrochen, es bleibt nichts zurück. */
  timeoutMS?: number;
}

export interface FinishGameResult {
  guestsUpdated: number;
  questionsUpdated: number;
  /** `stale`: in der DB stand ein neuerer bzw. geschlossener Lobby-Stand – nicht überschrieben. */
  lobby: "saved" | "stale";
}

export async function finishGame(
  client: MongoClient,
  collections: Collections,
  input: FinishGameInput,
  now: Date,
  options: FinishGameOptions = {},
): Promise<FinishGameResult> {
  const game = gameDocSchema.parse(input.game);
  const lobby = lobbyDocSchema.parse(input.lobby);
  const guestResults = input.guests.map((guest) => guestGameResultSchema.parse(guest));
  const questionOperations = questionStatsOperations(input.questionStats);
  return client.withSession((session) =>
    session.withTransaction(
      async () => {
        await collections.games.insertOne(game, { session });
        const lobbyResult = await writeLobbySnapshot(collections.lobbies, lobby, session);
        let guestsUpdated = 0;
        for (const result of guestResults) {
          const update = await collections.guests.updateOne(
            { _id: result.guestId },
            guestGameResultUpdate(result, now),
            {
              session,
            },
          );
          guestsUpdated += update.matchedCount;
        }
        let questionsUpdated = 0;
        for (const part of chunk(questionOperations, QUESTION_BATCH_SIZE)) {
          const bulk = await collections.questions.bulkWrite(part, { ordered: false, session });
          questionsUpdated += bulk.matchedCount;
        }
        return { guestsUpdated, questionsUpdated, lobby: lobbyResult };
      },
      { timeoutMS: options.timeoutMS ?? FINISH_GAME_TIMEOUT_MS },
    ),
  );
}
