import { gameDocSchema, lobbyDocSchema, RETENTION } from "@quizmaster/shared/documents";
import { describe, expect, it } from "vitest";
import { buildGameDoc, computeResults, GAME_SNAPSHOT_VERSION, toLobbySnapshot, toPublicState } from "../src/index.ts";
import { lobbyWith } from "./support/simulation.ts";

describe("Rangliste (docs/01 §Punkte & Ergebnis)", () => {
  it("gleiche Punkte = gleicher Platz (1, 1, 3); Aufgegebene hinter allen Aktiven", () => {
    const results = computeResults([
      { playerId: "a", status: "active", score: 5 },
      { playerId: "b", status: "resigned", score: 9 },
      { playerId: "c", status: "active", score: 3 },
      { playerId: "d", status: "active", score: 5 },
      { playerId: "e", status: "resigned", score: 9 },
      { playerId: "f", status: "resigned", score: 1 },
    ]);
    expect(results.ranking.map((entry) => [entry.playerId, entry.place])).toEqual([
      ["a", 1],
      ["d", 1],
      ["c", 3],
      ["b", 4],
      ["e", 4],
      ["f", 6],
    ]);
    expect(results.outcome).toBe("win");
  });

  it("2 Personen → win oder draw; alle Aktiven gleichauf → draw; eine aktive Person → win", () => {
    const outcome = (scores: Array<[number, "active" | "resigned"]>) =>
      computeResults(scores.map(([score, status], index) => ({ playerId: `p${index}`, score, status }))).outcome;
    expect(
      outcome([
        [7, "active"],
        [5, "active"],
      ]),
    ).toBe("win");
    expect(
      outcome([
        [4, "active"],
        [4, "active"],
      ]),
    ).toBe("draw");
    expect(
      outcome([
        [2, "active"],
        [2, "active"],
        [9, "resigned"],
      ]),
    ).toBe("draw");
    expect(
      outcome([
        [0, "active"],
        [9, "resigned"],
      ]),
    ).toBe("win");
    expect(
      computeResults([
        { playerId: "x", score: 0, status: "active" },
        { playerId: "y", score: 9, status: "resigned" },
      ]).ranking.map((entry) => entry.place),
    ).toEqual([1, 2]);
  });
});

describe("games-Dokument und Statistik (Effect gameFinished)", () => {
  it("gültig nach gameDocSchema; Mischung, Antworten und Plätze stimmen", () => {
    const sim = lobbyWith(3, 1, { seed: "gamedoc" });
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 2, questionsPerCategory: 2 } });
    sim.ok({ type: "START", guestId: sim.host });
    const [a = ""] = sim.guests;
    sim.playToEnd((guest, s) => (guest === a ? s.correct : (((s.correct + 1) % 4) as 0 | 1 | 2 | 3)));
    const finished = sim.effectsOf("gameFinished");
    expect(finished).toHaveLength(1);
    const { game, stats } = finished[0] ?? { game: undefined, stats: undefined };
    if (!game || !stats) throw new Error("gameFinished fehlt");
    expect(gameDocSchema.safeParse(game).success).toBe(true);
    expect(game).toEqual(buildGameDoc(sim.state));
    expect(game.expiresAt.getTime() - game.endedAt.getTime()).toBe(RETENTION.gameMs);
    expect(game.turns).toHaveLength(2 * 4);
    expect(game.players.map((player) => player.place)).toEqual(
      toPublicState(sim.state).results?.ranking.map((entry) => entry.place),
    );
    expect(game.players.find((player) => player.isBot)?.guestId.startsWith("bot:")).toBe(true);
    for (const turn of game.turns) {
      expect(turn.offered).toContain(turn.categoryId);
      for (const question of turn.questions) {
        const correctPosition = question.shownOrder.indexOf(0);
        for (const answer of question.answers) expect(answer.correct).toBe(answer.choice === correctPosition);
        expect(question.answers).toHaveLength(4);
      }
    }
    // Statistik nur für Menschen; a hat alles richtig, alle anderen Menschen nichts.
    expect(stats.guests).toHaveLength(3);
    const statsOfA = stats.guests.find((entry) => entry.guestId === a);
    expect(statsOfA).toMatchObject({ won: true, draw: false, answers: 16, correct: 16 });
    expect(statsOfA?.questionIds).toHaveLength(16);
    expect(stats.questions).toHaveLength(16);
    for (const question of stats.questions) expect(question).toMatchObject({ shown: 3, correct: 1 });
  });

  it("buildGameDoc wirft, solange das Spiel läuft", () => {
    const sim = lobbyWith(2);
    sim.ok({ type: "START", guestId: sim.host });
    expect(() => buildGameDoc(sim.state)).toThrow();
  });
});

describe("Lobby-Snapshot (Effect persist)", () => {
  it("gültig nach lobbyDocSchema in allen Lebensphasen; enthält Server-Daten nur für die DB", () => {
    const sim = lobbyWith(2, 1, { seed: "snapshot" });
    const lobby = toLobbySnapshot(sim.state);
    expect(lobbyDocSchema.safeParse(lobby).success).toBe(true);
    expect(lobby).toMatchObject({ active: true, phase: "lobby", game: null, code: "ABC234" });
    expect(lobby.players.map((player) => player.guestId)).toContain(sim.host);
    expect(lobby.expiresAt.getTime() - lobby.updatedAt.getTime()).toBe(RETENTION.activeLobbyMs);

    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 1, questionsPerCategory: 1 } });
    sim.ok({ type: "START", guestId: sim.host });
    sim.runUntil((state) => state.phase === "question");
    const running = toLobbySnapshot(sim.state);
    expect(lobbyDocSchema.safeParse(running).success).toBe(true);
    expect(running.game?.snapshotVersion).toBe(GAME_SNAPSHOT_VERSION);
    expect(running.game?.order).toEqual(sim.state.game?.order);

    sim.playToEnd();
    const over = toLobbySnapshot(sim.state);
    expect(lobbyDocSchema.safeParse(over).success).toBe(true);
    expect(over.expiresAt.getTime()).toBe((sim.state.game?.endedAt ?? 0) + RETENTION.endedLobbyMs);

    sim.ok({ type: "LEAVE", guestId: sim.host });
    sim.ok({ type: "LEAVE", guestId: sim.guests[1] ?? "" });
    const closed = toLobbySnapshot(sim.state);
    expect(closed.active).toBe(false);
    expect(lobbyDocSchema.safeParse(closed).success).toBe(true);
  });

  it("persist-Effects: höchstens einer je Command, mit dem wichtigsten Anlass", () => {
    const sim = lobbyWith(2);
    for (const step of sim.steps) {
      if (!step.result.ok) continue;
      expect(step.result.effects.filter((effect) => effect.type === "persist").length).toBeLessThanOrEqual(1);
    }
    const from = sim.effects.length;
    sim.ok({ type: "START", guestId: sim.host });
    expect(sim.effectsOf("persist", from)).toEqual([{ type: "persist", reason: "game_started" }]);
  });
});
