/**
 * Spielabschluss (docs/04 §Fragenauswahl 6, docs/02 §MongoDB „Transaktionen“): Effect `gameFinished` →
 * `repos.finishGame` – in EINER Transaktion `games.insertOne`, Lobby-Snapshot, je Gast Statistik (`$inc`) und
 * `recentQuestionIds` (`$push` + `$slice: -1000`) sowie die Fragen-Statistik per `bulkWrite`.
 *
 * - Nur Menschen: Die Engine liefert in `stats.guests` bereits nur menschliche Gäste; synthetische Bot-IDs
 *   („bot:…“) werden hier zusätzlich verworfen (sie haben kein guests-Dokument).
 * - Läuft im Hintergrund (blockiert die Warteschlange der Lobby nie). Transiente Fehler: bis zu
 *   `FINISH_GAME_ATTEMPTS` Versuche mit Pause. Ein E11000 auf die Spiel-ID heißt „bereits gespeichert“ (ein
 *   früherer Versuch war erfolgreich, nur die Antwort ging verloren) – dann wird nichts erneut gezählt.
 */
import { type FinishGameInput, type GuestGameResult, isDuplicateKeyError, type Repositories } from "@quizmaster/db";
import type { GameStats } from "@quizmaster/game-engine";
import { guestIdSchema } from "@quizmaster/shared";
import type { GameDoc, LobbyDoc } from "@quizmaster/shared/documents";
import type { Logger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";

/** Versuche insgesamt (jeder Versuch hat die Transaktionsfrist aus `@quizmaster/db`). */
export const FINISH_GAME_ATTEMPTS = 3;
/** Pausen zwischen den Versuchen. */
export const FINISH_GAME_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];

export type FinishOutcome = "saved" | "already_saved" | "failed";

export interface FinishGameDeps {
  repos: Pick<Repositories, "finishGame">;
  logger: Logger;
  metrics: RealtimeMetrics;
  retryDelaysMs?: readonly number[];
}

/** Gast-Ergebnisse für die Transaktion (nur Menschen mit UUID, Bots ausgenommen). */
export function guestResultsFrom(stats: GameStats): GuestGameResult[] {
  return stats.guests
    .filter((guest) => guestIdSchema.safeParse(guest.guestId).success)
    .map((guest) => ({
      guestId: guest.guestId,
      questionIds: [...guest.questionIds],
      stats: {
        games: 1,
        wins: guest.won ? 1 : 0,
        draws: guest.draw ? 1 : 0,
        answers: guest.answers,
        correct: guest.correct,
      },
    }));
}

/** Eingabe der Abschluss-Transaktion aus dem Effect und dem Lobby-Snapshot nach Spielende. */
export function finishGameInput(game: GameDoc, stats: GameStats, lobby: LobbyDoc): FinishGameInput {
  return {
    game,
    lobby,
    guests: guestResultsFrom(stats),
    questionStats: stats.questions.map((entry) => ({ ...entry })),
  };
}

/** DB-IDs der gespielten Fragen in Spielreihenfolge (für „gesehene Fragen“ der Lobby). */
export function playedQuestionIds(game: GameDoc): string[] {
  return game.turns.flatMap((turn) => turn.questions.map((question) => question.questionId));
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** E11000 genau auf dieses Spiel (`_id` = Spiel-ID) – nicht etwa auf die Lobby in derselben Transaktion. */
function isGameAlreadySaved(error: unknown, gameId: string): boolean {
  if (!isDuplicateKeyError(error, "_id")) return false;
  const keyValue = (error as { keyValue?: unknown }).keyValue;
  if (typeof keyValue !== "object" || keyValue === null) return true;
  return (keyValue as { _id?: unknown })._id === gameId;
}

/** Schreibt das Spiel mit Wiederholung; wirft nie (Ergebnis + Logs/Metriken). */
export async function recordFinishedGame(
  deps: FinishGameDeps,
  input: FinishGameInput,
  now: () => number,
): Promise<FinishOutcome> {
  const delays = deps.retryDelaysMs ?? FINISH_GAME_RETRY_DELAYS_MS;
  const gameId = input.game._id;
  for (let attempt = 1; attempt <= FINISH_GAME_ATTEMPTS; attempt++) {
    try {
      const result = await deps.repos.finishGame(input, new Date(now()));
      deps.logger.info(
        {
          game: gameId,
          guests: input.guests.length,
          guestsUpdated: result.guestsUpdated,
          questionsUpdated: result.questionsUpdated,
          lobbySnapshot: result.lobby,
        },
        "Spiel gespeichert",
      );
      return "saved";
    } catch (error) {
      if (isGameAlreadySaved(error, gameId)) {
        deps.logger.info({ game: gameId }, "Spiel war bereits gespeichert – nicht erneut gezählt");
        return "already_saved";
      }
      deps.metrics.recordMongoError("finish_game");
      const delay = delays[attempt - 1];
      const last = attempt >= FINISH_GAME_ATTEMPTS || delay === undefined;
      deps.logger.warn({ err: error, game: gameId, attempt, final: last }, "Spielabschluss fehlgeschlagen");
      if (last) break;
      await sleep(delay);
    }
  }
  deps.logger.error({ game: gameId }, "Spielabschluss endgültig fehlgeschlagen – Statistik fehlt");
  return "failed";
}
