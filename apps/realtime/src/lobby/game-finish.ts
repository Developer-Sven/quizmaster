/**
 * Spielabschluss (docs/04 §Fragenauswahl 6, docs/02 §MongoDB „Transaktionen“): Effect `gameFinished` →
 * `repos.finishGame` – in EINER Transaktion `games.insertOne`, Lobby-Snapshot, je Gast Statistik (`$inc`) und
 * `recentQuestionIds` (`$push` + `$slice: -1000`) sowie die Fragen-Statistik per `bulkWrite`.
 *
 * - Nur Menschen: Die Engine liefert in `stats.guests` bereits nur menschliche Gäste; synthetische Bot-IDs
 *   („bot:…“) werden hier zusätzlich verworfen (sie haben kein guests-Dokument).
 * - Abgebrochene Spiele (`load_failed`, technischer Abbruch): zählen in `guests.stats` nicht als Spiel, Sieg
 *   oder Unentschieden. Antworten, gesehene Fragen und Fragen-Statistik bleiben – sie wurden wirklich gespielt.
 * - Läuft im Hintergrund (blockiert die Warteschlange der Lobby nie). Transiente Fehler: bis zu
 *   `FINISH_GAME_ATTEMPTS` Versuche mit Pause, danach übernimmt die Abschluss-Warteschlange
 *   (`createFinishQueue`) und versucht es alle `FINISH_RETRY_INTERVAL_MS` erneut, solange der Prozess läuft.
 *   Ein E11000 auf die Spiel-ID heißt „bereits gespeichert“ (ein früherer Versuch war erfolgreich, nur die
 *   Antwort ging verloren) – dann wird nichts erneut gezählt. Dauerhaft ungültige Eingaben (ZodError,
 *   Dokument-Validierung) werden nicht wiederholt.
 * - Endgültig verloren (ungültig, Warteschlange voll, Shutdown): Metrik `qm_games_lost_total{reason}` und ein
 *   Fehlerlog mit Spiel-ID, Lobby-Code und Umfang – bewusst OHNE die Daten selbst (guestIds sind geheim,
 *   docs/06); der Endstand steht noch bis zu 2 h im Lobby-Snapshot (`lobbies.game`).
 */
import {
  type FinishGameInput,
  type FinishGameResult,
  type GuestGameResult,
  isDuplicateKeyError,
  MONGO_ERROR_CODES,
  mongoErrorCode,
  type Repositories,
} from "@quizmaster/db";
import type { GameEndReason, GameStats } from "@quizmaster/game-engine";
import { guestIdSchema } from "@quizmaster/shared";
import type { GameDoc, LobbyDoc } from "@quizmaster/shared/documents";
import { ZodError } from "zod";
import type { Logger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";

/** Versuche insgesamt in der ersten Versuchsreihe (jeder Versuch hat die Transaktionsfrist aus `@quizmaster/db`). */
export const FINISH_GAME_ATTEMPTS = 3;
/** Pausen zwischen den Versuchen. */
export const FINISH_GAME_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];
/** Abstand der Wiederholungen im Hintergrund (je Durchlauf ein Versuch je vorgemerktem Spiel). */
export const FINISH_RETRY_INTERVAL_MS = 30_000;
/** Höchstens so viele Abschlüsse warten auf eine Wiederholung (Speicher bei langem Datenbank-Ausfall). */
export const FINISH_QUEUE_MAX = 200;

/** `invalid` = dauerhaft ungültige Eingabe (wird nie gespeichert); `failed` = transient, später erneut. */
export type FinishOutcome = "saved" | "already_saved" | "invalid" | "failed";

/** Warum ein Abschluss endgültig verloren ist (Label von `qm_games_lost_total`). */
export type FinishLossReason = "invalid" | "overflow" | "shutdown";

export interface FinishGameDeps {
  repos: Pick<Repositories, "finishGame">;
  logger: Logger;
  metrics: RealtimeMetrics;
  retryDelaysMs?: readonly number[];
}

/** Technischer Abbruch (nicht: regulär beendet oder zu wenige Aktive nach Aufgaben). */
export function isAbortedGame(endReason: GameEndReason | null): boolean {
  return endReason === "load_failed";
}

/** Gast-Ergebnisse für die Transaktion (nur Menschen mit UUID, Bots ausgenommen). */
export function guestResultsFrom(stats: GameStats, options: { aborted?: boolean } = {}): GuestGameResult[] {
  const counted = options.aborted !== true;
  return stats.guests
    .filter((guest) => guestIdSchema.safeParse(guest.guestId).success)
    .map((guest) => ({
      guestId: guest.guestId,
      questionIds: [...guest.questionIds],
      stats: {
        games: counted ? 1 : 0,
        wins: counted && guest.won ? 1 : 0,
        draws: counted && guest.draw ? 1 : 0,
        answers: guest.answers,
        correct: guest.correct,
      },
    }));
}

/** Eingabe der Abschluss-Transaktion aus dem Effect und dem Lobby-Snapshot nach Spielende. */
export function finishGameInput(
  game: GameDoc,
  stats: GameStats,
  lobby: LobbyDoc,
  options: { aborted?: boolean } = {},
): FinishGameInput {
  return {
    game,
    lobby,
    guests: guestResultsFrom(stats, options),
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

/** Dauerhaft ungültige Eingabe – eine Wiederholung kann nie gelingen. */
function isPermanentFailure(error: unknown): boolean {
  if (error instanceof ZodError || (error instanceof Error && error.name === "ZodError")) return true;
  return mongoErrorCode(error) === MONGO_ERROR_CODES.documentValidationFailure;
}

/** Umfang eines Abschlusses für Logs – ohne guestIds (geheim) und ohne Spielinhalt. */
function describeFinish(input: FinishGameInput) {
  return {
    game: input.game._id,
    lobby: input.game.code,
    guests: input.guests.length,
    questions: input.questionStats.length,
  };
}

function logSaved(deps: FinishGameDeps, input: FinishGameInput, result: FinishGameResult): void {
  deps.logger.info(
    {
      game: input.game._id,
      guests: input.guests.length,
      guestsUpdated: result.guestsUpdated,
      questionsUpdated: result.questionsUpdated,
      lobbySnapshot: result.lobby,
    },
    "Spiel gespeichert",
  );
  if (result.guestsUpdated < input.guests.length) {
    deps.logger.warn(
      { game: input.game._id, guests: input.guests.length, guestsUpdated: result.guestsUpdated },
      "Statistik nicht für alle Gäste gespeichert – guests-Dokument fehlt (z. B. per TTL gelöscht)",
    );
  }
}

/** Schreibt das Spiel mit Wiederholung (erste Versuchsreihe); wirft nie (Ergebnis + Logs/Metriken). */
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
      logSaved(deps, input, result);
      return "saved";
    } catch (error) {
      if (isGameAlreadySaved(error, gameId)) {
        deps.logger.info({ game: gameId }, "Spiel war bereits gespeichert – nicht erneut gezählt");
        return "already_saved";
      }
      deps.metrics.recordMongoError("finish_game");
      if (isPermanentFailure(error)) {
        deps.logger.error({ err: error, game: gameId }, "Spielabschluss ungültig – keine Wiederholung");
        return "invalid";
      }
      const delay = delays[attempt - 1];
      const last = attempt >= FINISH_GAME_ATTEMPTS || delay === undefined;
      deps.logger.warn({ err: error, game: gameId, attempt, final: last }, "Spielabschluss fehlgeschlagen");
      if (last) break;
      await sleep(delay);
    }
  }
  return "failed";
}

export interface FinishQueue {
  /**
   * Speichert einen Spielabschluss (erste Versuchsreihe); scheitert sie transient, bleibt er für Wiederholungen
   * im Hintergrund vorgemerkt. Wirft nie; das Ergebnis betrifft nur die erste Versuchsreihe.
   */
  record(input: FinishGameInput): Promise<FinishOutcome>;
  /** Spiel-IDs, deren Abschluss gerade läuft oder auf eine Wiederholung wartet. */
  openGameIds(): string[];
  /**
   * Shutdown: keine Wiederholungen mehr. Vorgemerkte Abschlüsse sind verloren (Fehlerlog + Metrik); laufende
   * werden höchstens `waitMs` abgewartet. Liefert die Spiel-IDs, die danach noch nicht gespeichert sind.
   */
  shutdown(waitMs: number): Promise<string[]>;
}

export interface FinishQueueDeps extends FinishGameDeps {
  now: () => number;
  retryIntervalMs?: number;
  maxPending?: number;
}

/** Prozessweite Abschluss-Warteschlange (eine je Lobby-Registry). */
export function createFinishQueue(deps: FinishQueueDeps): FinishQueue {
  const retryIntervalMs = deps.retryIntervalMs ?? FINISH_RETRY_INTERVAL_MS;
  const maxPending = deps.maxPending ?? FINISH_QUEUE_MAX;
  /** Laufende Versuche je Spiel-ID. */
  const running = new Map<string, Promise<FinishOutcome>>();
  /** Auf eine Wiederholung wartende Abschlüsse (älteste zuerst). */
  const pending = new Map<string, FinishGameInput>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retrying = false;
  let stopped = false;

  const lose = (input: FinishGameInput, reason: FinishLossReason) => {
    deps.metrics.gamesLost.inc({ reason });
    deps.logger.error(
      { ...describeFinish(input), reason },
      "Spielabschluss endgültig verloren – Statistik fehlt (Endstand im Lobby-Snapshot)",
    );
  };

  const schedule = () => {
    if (stopped || timer !== undefined || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void retryPending();
    }, retryIntervalMs);
    timer.unref();
  };

  /** Nach einem transienten Fehlschlag: vormerken (begrenzt) oder – im Shutdown – als verloren melden. */
  const keepForRetry = (input: FinishGameInput) => {
    if (stopped) {
      lose(input, "shutdown");
      return;
    }
    if (!pending.has(input.game._id) && pending.size >= maxPending) {
      lose(input, "overflow");
      return;
    }
    pending.set(input.game._id, input);
    deps.logger.warn(
      { ...describeFinish(input), retryInMs: retryIntervalMs, pending: pending.size },
      "Spielabschluss vorgemerkt – neuer Versuch im Hintergrund",
    );
    schedule();
  };

  const run = (input: FinishGameInput, attempt: () => Promise<FinishOutcome>): Promise<FinishOutcome> => {
    const gameId = input.game._id;
    const promise = attempt()
      .catch((error: unknown): FinishOutcome => {
        deps.logger.error({ err: error, game: gameId }, "Spielabschluss: unerwarteter Fehler");
        return "failed";
      })
      .then((outcome) => {
        running.delete(gameId);
        if (outcome === "invalid") lose(input, "invalid");
        else if (outcome === "failed") keepForRetry(input);
        return outcome;
      });
    running.set(gameId, promise);
    return promise;
  };

  /** Ein Versuch je vorgemerktem Spiel; scheitert einer, wartet der Rest auf den nächsten Durchlauf. */
  const retryPending = async () => {
    if (retrying) return;
    retrying = true;
    try {
      for (const [gameId, input] of [...pending]) {
        if (stopped) return;
        pending.delete(gameId);
        const outcome = await run(input, () => recordFinishedGame({ ...deps, retryDelaysMs: [] }, input, deps.now));
        if (outcome === "saved" || outcome === "already_saved") {
          deps.logger.info({ game: gameId }, "Spielabschluss nachträglich gespeichert");
        }
        if (outcome === "failed") break;
      }
    } finally {
      retrying = false;
      schedule();
    }
  };

  return {
    record(input) {
      return run(input, () => recordFinishedGame(deps, input, deps.now));
    },

    openGameIds: () => [...new Set([...running.keys(), ...pending.keys()])],

    async shutdown(waitMs) {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const lost = [...pending.keys()];
      for (const input of pending.values()) lose(input, "shutdown");
      pending.clear();
      if (running.size > 0) await Promise.race([Promise.allSettled([...running.values()]), sleep(waitMs)]);
      return [...lost, ...running.keys()];
    },
  };
}
