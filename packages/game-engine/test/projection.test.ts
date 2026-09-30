import {
  CLIENT_FORBIDDEN_KEYS,
  findKeysDeep,
  PRE_REVEAL_FORBIDDEN_KEYS,
  ProtocolError,
  privatePlayerStateSchema,
  publicLobbyStateSchema,
  reviewListSchema,
} from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import {
  currentQuestion,
  currentTurn,
  findShownQuestion,
  reviewQuestionIds,
  toPrivateState,
  toPublicState,
  toReviewItems,
} from "../src/index.ts";
import { lobbyWith, type Simulation } from "./support/simulation.ts";

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectValidPayloads(sim: Simulation): void {
  const pub = roundTrip(toPublicState(sim.state));
  expect(publicLobbyStateSchema.safeParse(pub).success).toBe(true);
  expect(findKeysDeep(pub, [...CLIENT_FORBIDDEN_KEYS, "source"])).toEqual([]);
  for (const player of sim.state.players) {
    const priv = roundTrip(toPrivateState(sim.state, player.playerId));
    expect(privatePlayerStateSchema.safeParse(priv).success).toBe(true);
    expect(findKeysDeep(priv, [...CLIENT_FORBIDDEN_KEYS, ...PRE_REVEAL_FORBIDDEN_KEYS])).toEqual([]);
  }
}

describe("toPublicState / toPrivateState", () => {
  it("vor reveal keine Geheimnisse; ab reveal richtige Antwort, Wahlen und Erklärung", () => {
    // Seed so gewählt, dass eine Frage mit Erklärung vorkommt; Fixtures enthalten `source` → darf nie erscheinen.
    const sim = lobbyWith(3, 1, { seed: "leak" });
    sim.ok({ type: "START", guestId: sim.host });
    sim.runUntil((state) => state.phase === "question");
    sim.toQuestionStart();
    const [a = "", b = ""] = sim.guests;
    sim.answer(a, sim.correct);
    sim.answer(b, ((sim.correct + 1) % 4) as 0 | 1 | 2 | 3);
    const during = roundTrip(toPublicState(sim.state));
    expect(findKeysDeep(during, PRE_REVEAL_FORBIDDEN_KEYS)).toEqual([]);
    expect(during.players.every((player) => player.score === 0)).toBe(true);
    expect(during.board).toEqual([]);
    expectValidPayloads(sim);

    const question = currentQuestion(sim.state.game);
    sim.runUntil((state) => state.phase === "reveal");
    const reveal = toPublicState(sim.state).question;
    expect(reveal?.answers).toEqual(during.question?.answers);
    expect(reveal?.correct).toBe(question?.correct);
    expect(reveal?.explanation).toBe(question?.explanation);
    expect(reveal?.picks?.[sim.playerId(a)]).toBe(question?.correct);
    expect(Object.keys(reveal?.picks ?? {})).toHaveLength(4);
    expect(
      findKeysDeep(roundTrip(toPublicState(sim.state)), ["source", "guestId", "shownOrder", "questionId"]),
    ).toEqual([]);
    const scores = toPublicState(sim.state).players.map((player) => player.score);
    expect(scores[0]).toBe(1);
    expect(scores[1]).toBe(0);
    expectValidPayloads(sim);
  });

  it("Tafel und Punkte enthalten nur aufgelöste Fragen", () => {
    const sim = lobbyWith(2, 0, { seed: "board" });
    sim.ok({ type: "START", guestId: sim.host });
    sim.runUntil((state) => state.phase === "question");
    sim.toQuestionStart();
    for (const guest of sim.guests) sim.answer(guest, sim.correct);
    sim.runUntil((state) => state.phase === "question" && (currentTurn(state.game)?.currentIndex ?? 0) === 1);
    sim.toQuestionStart();
    for (const guest of sim.guests) sim.answer(guest, sim.correct);
    const pub = toPublicState(sim.state);
    expect(pub.board).toHaveLength(1);
    for (const results of Object.values(pub.board[0]?.results ?? {})) expect(results).toEqual([true]);
    expect(pub.players.map((player) => player.score)).toEqual([1, 1]);
  });

  it("canPick nur für die wählende Person vor der Wahl; myAnswer nur in question/reveal", () => {
    const sim = lobbyWith(2);
    sim.ok({ type: "START", guestId: sim.host });
    sim.runUntil((state) => state.phase === "category_pick");
    const turn = currentTurn(sim.state.game);
    const flags = sim.state.players.map((player) => toPrivateState(sim.state, player.playerId).canPick);
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect(toPrivateState(sim.state, turn?.pickerId ?? "").canPick).toBe(true);
    sim.runUntil((state) => state.phase === "question");
    sim.toQuestionStart();
    const guest = sim.guests[0] ?? "";
    sim.answer(guest, 1);
    sim.runUntil((state) => state.phase === "reveal");
    expect(toPrivateState(sim.state, sim.playerId(guest)).myAnswer?.choice).toBe(1);
    sim.runUntil((state) => state.phase !== "reveal");
    expect(toPrivateState(sim.state, sim.playerId(guest)).myAnswer).toBeNull();
  });

  it("gültige Payloads ohne guestId in allen Phasen eines kompletten Spiels", () => {
    const sim = lobbyWith(3, 2, { seed: "phases" });
    expectValidPayloads(sim);
    sim.ok({ type: "START", guestId: sim.host });
    const phases = new Set<string>();
    for (let i = 0; i < 5_000 && sim.state.phase !== "game_over"; i++) {
      phases.add(sim.state.phase);
      expectValidPayloads(sim);
      sim.fireNext();
    }
    expectValidPayloads(sim);
    expect(phases.size).toBe(6);
  });

  it("toPrivateState wirft bei unbekannter Person", () => {
    const sim = lobbyWith(2);
    expect(() => toPrivateState(sim.state, "unbekannt")).toThrow(RangeError);
  });
});

describe("Rückblick, Bewertung und Meldung", () => {
  it("toReviewItems nur in game_over; Antworten wie im Spiel, eigene Bewertung/Meldung je DB-ID", () => {
    const sim = lobbyWith(2, 0, { seed: "review" });
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 1, questionsPerCategory: 2 } });
    sim.ok({ type: "START", guestId: sim.host });
    sim.runUntil((state) => state.phase === "question");
    const shownAnswers = toPublicState(sim.state).question?.answers;
    const firstInstance = sim.questionId;
    const firstDbId = currentQuestion(sim.state.game)?.questionId ?? "";
    const hostId = sim.playerId(sim.host);
    expect(() => toReviewItems(sim.state, hostId, { ratings: new Map(), reported: new Set() })).toThrow(ProtocolError);
    expect(findShownQuestion(sim.state, firstInstance)).toEqual({
      questionId: firstDbId,
      categoryId: currentQuestion(sim.state.game)?.categoryId,
    });
    const future = currentTurn(sim.state.game)?.questions[1]?.instanceId ?? "";
    expect(findShownQuestion(sim.state, future)).toBeNull();
    expect(findShownQuestion(sim.state, "gibtsnicht")).toBeNull();

    sim.playToEnd();
    const items = toReviewItems(sim.state, hostId, {
      ratings: new Map([[firstDbId, -1]]),
      reported: new Set([firstDbId]),
    });
    expect(reviewListSchema.safeParse(items).success).toBe(true);
    expect(items).toHaveLength(4);
    expect(reviewQuestionIds(sim.state)).toHaveLength(4);
    const first = items[0];
    expect(first).toMatchObject({ questionId: firstInstance, myRating: -1, myReported: true, answers: shownAnswers });
    expect(items.slice(1).every((item) => item.myRating === null && !item.myReported)).toBe(true);
    const game = sim.state.game;
    for (const [index, item] of items.entries()) {
      const question = game?.turns.flatMap((turn) => turn.questions)[index];
      expect(item.correct).toBe(question?.correct);
      expect(item.answers[item.correct]).toBe(sim.catalog.docs.get(question?.questionId ?? "")?.answers[0]);
    }
  });
});
