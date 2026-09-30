import type { AnswerIndex, Difficulty } from "@quizmaster/shared";
import { getTimings } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import {
  botAccuracy,
  botAnswerDelayMs,
  botPickDelayMs,
  chooseBotAnswer,
  chooseBotCategory,
  createSeededRng,
  planBotMoves,
  reduce,
  toPublicState,
} from "../src/index.ts";
import { lobbyWith } from "./support/simulation.ts";

describe("Bot-Strategie (docs/05 §Dev-Bots)", () => {
  it("Trefferquote sinkt linear von 85 % (Stufe 1) auf 40 % (Stufe 5)", () => {
    expect([1, 2, 3, 4, 5].map((difficulty) => botAccuracy(difficulty as Difficulty))).toEqual([
      0.85, 0.7375, 0.625, 0.5125, 0.4,
    ]);
  });

  it("antwortet statistisch mit der Trefferquote; Fehlantworten sind nie die richtige", () => {
    const rng = createSeededRng("bot-hits");
    for (const difficulty of [1, 3, 5] as const) {
      let hits = 0;
      const wrong = new Set<AnswerIndex>();
      for (let i = 0; i < 20_000; i++) {
        const choice = chooseBotAnswer({ correct: 2, difficulty }, rng);
        if (choice === 2) hits++;
        else wrong.add(choice);
      }
      expect(hits / 20_000).toBeCloseTo(botAccuracy(difficulty), 1);
      expect([...wrong].sort()).toEqual([0, 1, 3]);
    }
  });

  it("ohne Kenntnis der Lösung (Lasttest-Client): gleichverteilt", () => {
    const rng = createSeededRng("blind");
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 20_000; i++) {
      const choice = chooseBotAnswer({ correct: null, difficulty: null }, rng);
      counts[choice] = (counts[choice] ?? 0) + 1;
    }
    for (const count of counts) expect(count / 20_000).toBeCloseTo(0.25, 1);
  });

  it("Antwort nach 2–12 s (normal) bzw. 200–1.200 ms (fast); Wahl nach 1,5–6 s", () => {
    const rng = createSeededRng("delays");
    const normal = getTimings("normal");
    const fast = getTimings("fast");
    const answers = Array.from({ length: 5_000 }, () => botAnswerDelayMs(normal, rng));
    expect(Math.min(...answers)).toBeGreaterThanOrEqual(2_000);
    expect(Math.max(...answers)).toBeLessThanOrEqual(12_000);
    expect(Math.max(...answers)).toBeGreaterThan(11_500);
    const fastAnswers = Array.from({ length: 2_000 }, () => botAnswerDelayMs(fast, rng));
    expect(Math.min(...fastAnswers)).toBeGreaterThanOrEqual(200);
    expect(Math.max(...fastAnswers)).toBeLessThanOrEqual(1_200);
    const picks = Array.from({ length: 2_000 }, () => botPickDelayMs(normal, rng));
    expect(Math.min(...picks)).toBeGreaterThanOrEqual(1_500);
    expect(Math.max(...picks)).toBeLessThanOrEqual(6_000);
    expect(chooseBotCategory([{ id: "a" }, { id: "b" }], rng).id).toMatch(/^[ab]$/);
  });

  it("planBotMoves: Bot wählt als wählende Person, Bots antworten vor der Deadline; reduce akzeptiert", () => {
    const sim = lobbyWith(1, 3, { seed: "bot-moves" });
    sim.ok({ type: "START", guestId: sim.host });
    // Bis ein Bot wählt.
    sim.runUntil((state) => {
      const turn = state.game?.turns.at(-1);
      const picker = state.players.find((player) => player.playerId === turn?.pickerId);
      return state.phase === "category_pick" && picker?.isBot === true;
    });
    const [pick] = planBotMoves(sim.state, createSeededRng(1));
    expect(pick?.command.type).toBe("PICK");
    expect(pick?.at).toBeGreaterThanOrEqual(sim.state.phaseStartedAt + 1_500);
    const accepted = reduce(sim.state, pick?.command ?? { type: "TIMEOUT", token: 0 }, {
      now: pick?.at ?? 0,
      rng: createSeededRng(2),
    });
    expect(accepted.ok).toBe(true);
    sim.runUntil((state) => state.phase === "question");
    const moves = planBotMoves(sim.state, createSeededRng(3));
    expect(moves).toHaveLength(3);
    const question = toPublicState(sim.state).question;
    for (const move of moves) {
      expect(move.command).toMatchObject({ type: "ANSWER", questionId: question?.id });
      expect(move.at).toBeGreaterThanOrEqual(question?.startsAt ?? 0);
      expect(move.at).toBeLessThan(question?.deadline ?? 0);
    }
    // Keine Aktionen in Phasen ohne Bot-Beteiligung.
    sim.runUntil((state) => state.phase === "reveal");
    expect(planBotMoves(sim.state, createSeededRng(4))).toEqual([]);
  });

  it("Host spielt allein gegen 3 Bots bis zum Ende (E2E-Szenario 8 in der Engine)", () => {
    const sim = lobbyWith(1, 3, { seed: "solo", timing: "fast" });
    sim.ok({ type: "START", guestId: sim.host });
    sim.playToEnd();
    const pub = toPublicState(sim.state);
    expect(pub.phase).toBe("game_over");
    expect(pub.board).toHaveLength(3 * 4);
    const botScores = pub.players.filter((player) => player.isBot).map((player) => player.score);
    // 36 Fragen je Bot: Trefferquote irgendwo zwischen 40 % und 85 %.
    for (const score of botScores) {
      expect(score).toBeGreaterThan(8);
      expect(score).toBeLessThan(34);
    }
  });
});
