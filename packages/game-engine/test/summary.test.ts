import type { BoardRow } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { standingsAfterRound, summarizeTurn, toPublicState } from "../src/index.ts";
import { lobbyWith } from "./support/simulation.ts";

describe("Zug-Ergebnis (docs/01 §Zug-Ergebnis)", () => {
  it("Punkte je Person dieses Zuges, beste zuerst; beste Person(en) markiert", () => {
    const row: BoardRow = {
      round: 1,
      pickerId: "a",
      categoryId: "im-labor",
      results: { a: [true, false, null], b: [true, true, false], c: [false, true, true] },
    };
    const summary = summarizeTurn(row);
    expect(summary.entries.map((entry) => [entry.playerId, entry.points])).toEqual([
      ["b", 2],
      ["c", 2],
      ["a", 1],
    ]);
    expect(summary.bestPlayerIds).toEqual(["b", "c"]);
    expect(summarizeTurn({ ...row, results: { a: [false], b: [null] } }).bestPlayerIds).toEqual([]);
  });

  it("passt in Phase turn_summary zur letzten Tafelzeile des Spiels", () => {
    const sim = lobbyWith(3, 0, { seed: "summary" });
    sim.ok({ type: "START", guestId: sim.host });
    const [a = ""] = sim.guests;
    let answered = "";
    sim.runUntil((state) => {
      if (state.phase === "question" && answered !== sim.questionId) {
        answered = sim.questionId;
        sim.toQuestionStart();
        if (sim.state.phase === "question") sim.answer(a, sim.correct);
      }
      return sim.state.phase === "turn_summary";
    });
    const pub = toPublicState(sim.state);
    const summary = summarizeTurn(pub.board.at(-1) as BoardRow);
    expect(summary.categoryId).toBe(pub.turn?.categoryId);
    expect(summary.entries[0]).toEqual({ playerId: sim.playerId(a), results: [true, true, true], points: 3 });
    expect(summary.bestPlayerIds).toEqual([sim.playerId(a)]);
  });
});

describe("Stand nach Runde (Platzierungswechsel der Rundentafel)", () => {
  it("rechnet nur Zeilen bis zur Runde; gleiche Punkte = gleicher Platz; Aufgegebene hinten", () => {
    const board: BoardRow[] = [
      { round: 1, pickerId: "a", categoryId: "comics", results: { a: [true], b: [false], c: [true] } },
      { round: 2, pickerId: "b", categoryId: "kinofilme", results: { a: [false], b: [true], c: [true] } },
      { round: 2, pickerId: "c", categoryId: "tv-serien", results: { a: [false], b: [true], c: [null] } },
    ];
    const players = [
      { id: "a", status: "active" as const },
      { id: "b", status: "active" as const },
      { id: "c", status: "resigned" as const },
    ];
    expect(standingsAfterRound(board, players, 1).map((entry) => [entry.playerId, entry.place, entry.score])).toEqual([
      ["a", 1, 1],
      ["b", 2, 0],
      ["c", 3, 1],
    ]);
    expect(standingsAfterRound(board, players, 2).map((entry) => [entry.playerId, entry.place, entry.score])).toEqual([
      ["b", 1, 2],
      ["a", 2, 1],
      ["c", 3, 2],
    ]);
  });
});
