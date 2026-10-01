/**
 * Spielabschluss ohne Datenbank (Fake-Repos): abgebrochene Spiele in der Statistik, dauerhafte Fehler ohne
 * Wiederholung, Hinweis bei fehlenden Gast-Dokumenten und die Abschluss-Warteschlange (Wiederholung im
 * Hintergrund, Überlauf, Shutdown).
 */
import { Writable } from "node:stream";
import type { FinishGameInput, FinishGameResult, Repositories } from "@quizmaster/db";
import type { GameStats } from "@quizmaster/game-engine";
import type { GameDoc, LobbyDoc } from "@quizmaster/shared/documents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createFinishQueue,
  FINISH_GAME_ATTEMPTS,
  finishGameInput,
  isAbortedGame,
  recordFinishedGame,
} from "../../src/lobby/game-finish.ts";
import { createLogger } from "../../src/logger.ts";
import { createMetrics } from "../../src/metrics.ts";
import { metricValue } from "../helpers/index.ts";

const GUEST_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const GUEST_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { logger: createLogger({ level: "debug", destination }), lines };
}

const stats: GameStats = {
  guests: [
    { guestId: GUEST_A, won: true, draw: false, answers: 4, correct: 3, questionIds: ["co-aaaaaaa1", "co-aaaaaaa2"] },
    { guestId: GUEST_B, won: false, draw: false, answers: 4, correct: 1, questionIds: ["co-aaaaaaa1", "co-aaaaaaa2"] },
    { guestId: "bot:1", won: false, draw: false, answers: 4, correct: 2, questionIds: [] },
  ],
  questions: [{ questionId: "co-aaaaaaa1", shown: 2, correct: 1 }],
};

/** Eingabe mit gegebener Spiel-ID (Inhalt ist für die Fake-Repos egal). */
function input(gameId: string, guests = 2): FinishGameInput {
  return {
    game: { _id: gameId, code: "ABC234" } as unknown as GameDoc,
    lobby: { _id: "lobby_1" } as unknown as LobbyDoc,
    guests: Array.from({ length: guests }, (_unused, index) => ({
      guestId: index === 0 ? GUEST_A : GUEST_B,
      questionIds: [],
      stats: { games: 1, wins: 0, draws: 0, answers: 0, correct: 0 },
    })),
    questionStats: [],
  };
}

const saved: FinishGameResult = { guestsUpdated: 2, questionsUpdated: 0, lobby: "saved" };

function fakeRepos(finishGame: (input: FinishGameInput) => Promise<FinishGameResult>) {
  const calls: string[] = [];
  const repos = {
    finishGame: async (value: FinishGameInput) => {
      calls.push(value.game._id);
      return finishGame(value);
    },
  } as unknown as Pick<Repositories, "finishGame">;
  return { repos, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Abgebrochene Spiele (load_failed)", () => {
  it("nur load_failed gilt als Abbruch", () => {
    expect(isAbortedGame("load_failed")).toBe(true);
    for (const reason of ["completed", "not_enough_players", null] as const) expect(isAbortedGame(reason)).toBe(false);
  });

  it("zählen nicht als Spiel/Sieg/Unentschieden; Antworten und gesehene Fragen bleiben; Bots fehlen", () => {
    const game = {} as GameDoc;
    const lobby = {} as LobbyDoc;
    const normal = finishGameInput(game, stats, lobby);
    expect(normal.guests.map((guest) => guest.stats)).toEqual([
      { games: 1, wins: 1, draws: 0, answers: 4, correct: 3 },
      { games: 1, wins: 0, draws: 0, answers: 4, correct: 1 },
    ]);
    const aborted = finishGameInput(game, stats, lobby, { aborted: true });
    expect(aborted.guests.map((guest) => guest.stats)).toEqual([
      { games: 0, wins: 0, draws: 0, answers: 4, correct: 3 },
      { games: 0, wins: 0, draws: 0, answers: 4, correct: 1 },
    ]);
    expect(aborted.guests.map((guest) => guest.questionIds)).toEqual([
      ["co-aaaaaaa1", "co-aaaaaaa2"],
      ["co-aaaaaaa1", "co-aaaaaaa2"],
    ]);
    expect(aborted.questionStats).toEqual(stats.questions);
  });
});

describe("recordFinishedGame", () => {
  it("dauerhaft ungültige Eingabe (ZodError) wird nicht wiederholt → invalid", async () => {
    const { repos, calls } = fakeRepos(async () => {
      z.object({ x: z.string() }).parse({});
      return saved;
    });
    const metrics = createMetrics({ socketCount: () => 0 });
    const { logger } = captureLogger();
    const outcome = await recordFinishedGame({ repos, logger, metrics, retryDelaysMs: [1, 1] }, input("g1"), Date.now);
    expect(outcome).toBe("invalid");
    expect(calls).toHaveLength(1);
  });

  it("transiente Fehler: bis zu FINISH_GAME_ATTEMPTS Versuche, dann failed", async () => {
    const { repos, calls } = fakeRepos(async () => {
      throw Object.assign(new Error("not primary"), { name: "MongoServerError", code: 10107 });
    });
    const metrics = createMetrics({ socketCount: () => 0 });
    const { logger } = captureLogger();
    const outcome = await recordFinishedGame({ repos, logger, metrics, retryDelaysMs: [1, 1] }, input("g1"), Date.now);
    expect(outcome).toBe("failed");
    expect(calls).toHaveLength(FINISH_GAME_ATTEMPTS);
    expect(await metricValue(metrics, "qm_mongo_errors_total", { operation: "finish_game" })).toBe(
      FINISH_GAME_ATTEMPTS,
    );
  });

  it("weniger aktualisierte Gäste als erwartet → Warnung (guests-Dokument fehlt)", async () => {
    const { repos } = fakeRepos(async () => ({ ...saved, guestsUpdated: 1 }));
    const metrics = createMetrics({ socketCount: () => 0 });
    const { logger, lines } = captureLogger();
    expect(await recordFinishedGame({ repos, logger, metrics }, input("g1"), Date.now)).toBe("saved");
    expect(lines.some((line) => line.level === 40 && line.guestsUpdated === 1 && line.guests === 2)).toBe(true);
  });
});

describe("Abschluss-Warteschlange", () => {
  it("fehlgeschlagener Abschluss wird im Hintergrund wiederholt, bis er gespeichert ist", async () => {
    let failing = true;
    const { repos, calls } = fakeRepos(async () => {
      if (failing) throw new Error("Datenbank weg");
      return saved;
    });
    const metrics = createMetrics({ socketCount: () => 0 });
    const { logger, lines } = captureLogger();
    const queue = createFinishQueue({
      repos,
      logger,
      metrics,
      now: Date.now,
      retryDelaysMs: [1, 1],
      retryIntervalMs: 30,
    });
    expect(await queue.record(input("g1"))).toBe("failed");
    expect(queue.openGameIds()).toEqual(["g1"]);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(FINISH_GAME_ATTEMPTS));
    failing = false;
    await vi.waitFor(() => expect(queue.openGameIds()).toEqual([]));
    expect(lines.some((line) => String(line.msg).includes("nachträglich gespeichert"))).toBe(true);
    expect(await metricValue(metrics, "qm_games_lost_total")).toBe(0);
    expect(await queue.shutdown(10)).toEqual([]);
  });

  it("ungültige Abschlüsse und Überlauf gelten sofort als verloren (Metrik je Grund, kein Rohdaten-Log)", async () => {
    const { repos } = fakeRepos(async (value) => {
      if (value.game._id === "invalid") z.object({ x: z.string() }).parse({});
      throw new Error("Datenbank weg");
    });
    const metrics = createMetrics({ socketCount: () => 0 });
    const { logger, lines } = captureLogger();
    const queue = createFinishQueue({
      repos,
      logger,
      metrics,
      now: Date.now,
      retryDelaysMs: [],
      retryIntervalMs: 60_000,
      maxPending: 1,
    });
    expect(await queue.record(input("invalid"))).toBe("invalid");
    expect(await queue.record(input("g1"))).toBe("failed");
    expect(await queue.record(input("g2"))).toBe("failed");
    expect(queue.openGameIds()).toEqual(["g1"]);
    expect(await metricValue(metrics, "qm_games_lost_total", { reason: "invalid" })).toBe(1);
    expect(await metricValue(metrics, "qm_games_lost_total", { reason: "overflow" })).toBe(1);
    const lost = lines.filter((line) => line.level === 50 && String(line.msg).includes("verloren"));
    expect(lost.map((line) => line.game)).toEqual(["invalid", "g2"]);
    // Nie die geheimen guestIds im Klartext (docs/06).
    expect(JSON.stringify(lines)).not.toContain(GUEST_A);
    await queue.shutdown(10);
  });

  it("Shutdown: wartende Wiederholungen sind verloren, laufende werden befristet abgewartet und gemeldet", async () => {
    let release: (value: FinishGameResult) => void = () => undefined;
    const { repos } = fakeRepos((value) => {
      if (value.game._id === "slow") {
        return new Promise<FinishGameResult>((resolve) => {
          release = resolve;
        });
      }
      return Promise.reject(new Error("Datenbank weg"));
    });
    const metrics = createMetrics({ socketCount: () => 0 });
    const { logger } = captureLogger();
    const queue = createFinishQueue({
      repos,
      logger,
      metrics,
      now: Date.now,
      retryDelaysMs: [],
      retryIntervalMs: 60_000,
    });
    expect(await queue.record(input("waiting"))).toBe("failed");
    const slow = queue.record(input("slow"));
    expect(queue.openGameIds().sort()).toEqual(["slow", "waiting"]);
    const started = Date.now();
    const unfinished = await queue.shutdown(50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(unfinished.sort()).toEqual(["slow", "waiting"]);
    expect(await metricValue(metrics, "qm_games_lost_total", { reason: "shutdown" })).toBe(1);
    // Nach dem Shutdown: keine Wiederholungen mehr; ein später doch gespeicherter Abschluss zählt nicht als verloren.
    release(saved);
    expect(await slow).toBe("saved");
    expect(await metricValue(metrics, "qm_games_lost_total", { reason: "shutdown" })).toBe(1);
    expect(await queue.record(input("late"))).toBe("failed");
    expect(await metricValue(metrics, "qm_games_lost_total", { reason: "shutdown" })).toBe(2);
  });
});
