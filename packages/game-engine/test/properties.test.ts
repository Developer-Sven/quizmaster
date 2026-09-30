/**
 * Property-Tests der Engine (docs/11 §Sicherheits-Invarianten 1, §Pflicht-Tests): fast-check erzeugt
 * zufällige Spielverläufe (Personen, Bots, Einstellungen, Antworten, Kategoriewahl, Timeouts, Reconnects,
 * Aufgeben, Kicks, veraltete Tokens). Nach JEDEM Command werden die Invarianten geprüft.
 */
import {
  type AnswerIndex,
  CLIENT_FORBIDDEN_KEYS,
  findKeysDeep,
  type GameTimingMode,
  PRE_REVEAL_FORBIDDEN_KEYS,
  privatePlayerStateSchema,
  publicLobbyStateSchema,
} from "@quizmaster/shared";
import { gameDocSchema, lobbyDocSchema } from "@quizmaster/shared/documents";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  computeScores,
  currentQuestion,
  currentTurn,
  type LobbyState,
  toLobbySnapshot,
  toPrivateState,
  toPublicState,
} from "../src/index.ts";
import { makeCatalog } from "./support/fixtures.ts";
import { Simulation, type SimulationStep } from "./support/simulation.ts";

const RUNNING = ["intro", "category_pick", "question", "reveal", "turn_summary", "round_board"];
const ALLOWED = new Set([
  "lobby>intro",
  "intro>category_pick",
  "category_pick>question",
  "question>reveal",
  "reveal>question",
  "reveal>turn_summary",
  "turn_summary>category_pick",
  "turn_summary>round_board",
  "round_board>category_pick",
  "round_board>game_over",
  "game_over>intro",
  ...RUNNING.map((phase) => `${phase}>game_over`),
]);

const catalog = makeCatalog({ categories: 8, perCategory: 60, topics: 4 });

type Action =
  | { kind: "answer"; who: number; choice: AnswerIndex; atStart: boolean }
  | { kind: "answerAll"; pattern: number }
  | { kind: "wrongQuestion"; who: number }
  | { kind: "pick"; who: number; option: number }
  | { kind: "disconnect"; who: number }
  | { kind: "reconnect"; who: number }
  | { kind: "leave"; who: number }
  | { kind: "kick"; who: number }
  | { kind: "wait"; ms: number }
  | { kind: "next" }
  | { kind: "stale"; which: number }
  | { kind: "rematch" };

const who = fc.nat({ max: 7 });
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant("answer"),
      who,
      choice: fc.constantFrom<AnswerIndex>(0, 1, 2, 3),
      atStart: fc.boolean(),
    }),
  },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("answerAll"), pattern: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("wrongQuestion"), who }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("pick"), who, option: fc.nat({ max: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("disconnect"), who }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("reconnect"), who }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("leave"), who }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("kick"), who }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("wait"), ms: fc.integer({ min: 0, max: 30_000 }) }) },
  { weight: 10, arbitrary: fc.record({ kind: fc.constant("next") }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("stale"), which: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("rematch") }) },
);

const scenarioArb = fc.record({
  seed: fc.integer(),
  humans: fc.integer({ min: 2, max: 5 }),
  bots: fc.integer({ min: 0, max: 3 }),
  rounds: fc.integer({ min: 1, max: 3 }),
  questionsPerCategory: fc.integer({ min: 1, max: 3 }),
  timing: fc.constantFrom<GameTimingMode>("normal", "fast"),
  // size "max": sonst begrenzt fast-check Arrays auf ~10 Elemente und Verläufe kämen kaum über den ersten Zug.
  actions: fc.array(actionArb, { minLength: 20, maxLength: 160, size: "max" }),
  afterRematch: fc.array(actionArb, { maxLength: 60, size: "max" }),
});

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Invariante 1 + Schema + Punkte: gilt für JEDEN erreichten Zustand. */
function checkPayloads(state: LobbyState): void {
  if (state.closed !== null) return;
  const pub = roundTrip(toPublicState(state));
  const parsed = publicLobbyStateSchema.safeParse(pub);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  expect(findKeysDeep(pub, [...CLIENT_FORBIDDEN_KEYS, "source", "shownOrder"])).toEqual([]);
  if (state.phase !== "reveal") expect(findKeysDeep(pub, PRE_REVEAL_FORBIDDEN_KEYS)).toEqual([]);
  for (const player of state.players) {
    const priv = roundTrip(toPrivateState(state, player.playerId));
    expect(privatePlayerStateSchema.safeParse(priv).success).toBe(true);
    expect(findKeysDeep(priv, [...PRE_REVEAL_FORBIDDEN_KEYS, ...CLIENT_FORBIDDEN_KEYS, "source"])).toEqual([]);
  }

  // Punkte = Anzahl „richtig“ auf der Tafel (nur aufgelöste Fragen) = +1 je richtiger Antwort, sonst nichts.
  const fromBoard = new Map<string, number>();
  for (const row of pub.board) {
    for (const [playerId, results] of Object.entries(row.results)) {
      fromBoard.set(playerId, (fromBoard.get(playerId) ?? 0) + results.filter((entry) => entry === true).length);
    }
  }
  for (const player of pub.players) expect(player.score).toBe(fromBoard.get(player.id) ?? 0);
  const scores = computeScores(state.game);
  for (const turn of state.game?.turns ?? []) {
    for (const question of turn.questions) {
      for (const outcome of question.outcomes ?? []) {
        expect(outcome.correct).toBe(outcome.choice !== null && outcome.choice === question.correct);
        const response = question.responses.find((entry) => entry.playerId === outcome.playerId);
        expect(outcome.choice).toBe(response?.choice ?? null);
      }
    }
  }
  for (const player of state.players)
    expect(scores.get(player.playerId) ?? 0).toBe(fromBoard.get(player.playerId) ?? 0);

  // Vor der Auflösung: laufende Frage weder in Tafel noch in Punkten.
  if (state.phase === "question") {
    const turn = currentTurn(state.game);
    const question = currentQuestion(state.game);
    expect(question?.outcomes).toBeNull();
    const row = pub.board.find((entry) => entry.round === turn?.round && entry.pickerId === turn.pickerId);
    const resolved = turn?.questions.filter((entry) => entry.outcomes !== null).length ?? 0;
    for (const results of Object.values(row?.results ?? {})) expect(results).toHaveLength(resolved);
    expect(pub.question?.correct).toBeUndefined();
  }

  // Struktur: Host ist menschliches Mitglied, Farben eindeutig, höchstens 8 Personen.
  const host = state.players.find((player) => player.playerId === state.hostPlayerId);
  expect(host && !host.isBot && !host.left).toBe(true);
  expect(new Set(state.players.map((player) => player.color)).size).toBe(state.players.length);
  expect(state.players.length).toBeLessThanOrEqual(8);
}

function checkStep(sim: Simulation, step: SimulationStep): void {
  const { before, result } = step;
  if (!result.ok) {
    // Ablehnung: Zustand unverändert, keine Effects.
    expect(result.state).toBe(before);
    expect(result.effects).toEqual([]);
    return;
  }
  const after = result.state;
  if (after === before) {
    expect(result.effects.filter((effect) => effect.type !== "broadcast" && effect.type !== "sendPrivate")).toEqual([]);
    return;
  }
  if (after.phase !== before.phase) {
    expect(ALLOWED.has(`${before.phase}>${after.phase}`), `${before.phase}>${after.phase}`).toBe(true);
  }
  expect(after.rev).toBeGreaterThanOrEqual(before.rev);
  expect(after.rev - before.rev).toBeLessThanOrEqual(1);
  const broadcast = result.effects.some((effect) => effect.type === "broadcast");
  if (after.rev > before.rev) expect(broadcast || after.closed !== null).toBe(true);
  expect(result.effects.filter((effect) => effect.type === "persist").length).toBeLessThanOrEqual(1);
  // Timer der Shell = Timer im Zustand (Effects vollständig abgeleitet).
  if (step === sim.steps.at(-1)) {
    expect([...sim.timers.keys()].sort((a, b) => a - b)).toEqual(
      after.timers.map((timer) => timer.token).sort((a, b) => a - b),
    );
  }
  checkPayloads(after);
}

function apply(sim: Simulation, action: Action): void {
  const guests = sim.guests;
  const guest = guests[("who" in action ? action.who : 0) % guests.length] ?? "";
  switch (action.kind) {
    case "answer": {
      if (action.atStart && sim.state.phase === "question") sim.toQuestionStart();
      const question = currentQuestion(sim.state.game);
      sim.dispatch({
        type: "ANSWER",
        guestId: guest,
        questionId: question?.instanceId ?? "keine",
        choice: action.choice,
      });
      return;
    }
    case "answerAll": {
      if (sim.state.phase !== "question") return;
      sim.toQuestionStart();
      sim.guests.forEach((entry, index) => {
        if (sim.state.phase !== "question") return;
        const choice = ((action.pattern >> (index * 2)) & 3) as AnswerIndex;
        sim.dispatch({
          type: "ANSWER",
          guestId: entry,
          questionId: currentQuestion(sim.state.game)?.instanceId ?? "keine",
          choice,
        });
      });
      return;
    }
    case "wrongQuestion":
      sim.dispatch({ type: "ANSWER", guestId: guest, questionId: "fremdeFrage1", choice: 0 });
      return;
    case "pick": {
      const turn = currentTurn(sim.state.game);
      const picker = sim.state.players.find((player) => player.playerId === turn?.pickerId);
      const actor = action.who % 2 === 0 && picker ? picker.guestId : guest;
      const categoryId = turn?.options[action.option]?.id ?? "zeugen-der-zeit";
      sim.dispatch({ type: "PICK", guestId: actor, categoryId });
      return;
    }
    case "disconnect":
      sim.dispatch({ type: "DISCONNECT", guestId: guest });
      return;
    case "reconnect":
      sim.dispatch({ type: "RECONNECT", guestId: guest });
      return;
    case "leave":
      sim.dispatch({ type: "LEAVE", guestId: guest });
      return;
    case "kick": {
      const target = sim.state.players[action.who % sim.state.players.length];
      sim.dispatch({
        type: "KICK",
        guestId: sim.state.closed ? guest : sim.host,
        targetPlayerId: target?.playerId ?? "x",
      });
      return;
    }
    case "wait":
      sim.advance(action.ms);
      return;
    case "next":
      sim.fireNext();
      return;
    case "stale": {
      const live = new Set(sim.state.timers.map((timer) => timer.token));
      const stale = Array.from({ length: sim.state.seq }, (_, index) => index + 1).filter((token) => !live.has(token));
      const token = stale[action.which % Math.max(1, stale.length)];
      if (token !== undefined) {
        const before = sim.state;
        const result = sim.dispatch({ type: "TIMEOUT", token });
        expect(result).toEqual({ ok: true, state: before, effects: [] });
      }
      return;
    }
    case "rematch":
      if (!sim.state.closed) sim.dispatch({ type: "REMATCH", guestId: sim.host });
      return;
  }
}

describe("Property: zufällige Spielverläufe", () => {
  it("Invariante 1 (kein Antwort-Leak), Punkte nur +1, erlaubte Übergänge, Reinheit, Timer, rev", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        let sim: Simulation | undefined;
        sim = new Simulation({
          seed: scenario.seed,
          timing: scenario.timing,
          catalog,
          freeze: true,
          onStep: (step) => {
            if (sim) checkStep(sim, step);
          },
        });
        const names = ["Ben", "Lea", "Tom", "Ida"];
        for (let i = 1; i < scenario.humans; i++) sim.join(names[i - 1] ?? `Gast ${i}`);
        for (let i = 0; i < Math.min(scenario.bots, 8 - scenario.humans); i++) sim.addBot();
        sim.ok({
          type: "UPDATE_SETTINGS",
          guestId: sim.host,
          update: { rounds: scenario.rounds, questionsPerCategory: scenario.questionsPerCategory },
        });
        sim.dispatch({ type: "START", guestId: sim.host });
        const finish = (current: Simulation) => {
          // Zu Ende laufen lassen: nur noch Timer und Bots.
          for (let i = 0; i < 20_000 && current.state.closed === null && RUNNING.includes(current.state.phase); i++) {
            if (!current.fireNext()) break;
          }
        };
        for (const action of scenario.actions) apply(sim, action);
        finish(sim);
        // Zweites Spiel per Revanche (gleiche Personen, neue Reihenfolge) mit weiteren Störungen.
        if (sim.state.closed === null && sim.state.phase === "game_over") {
          if (sim.dispatch({ type: "REMATCH", guestId: sim.host }).ok) {
            expect(toPublicState(sim.state).board).toEqual([]);
            for (const action of scenario.afterRematch) apply(sim, action);
            finish(sim);
          }
        }
        const state = sim.state;
        if (state.closed === null) expect(RUNNING.includes(state.phase)).toBe(false);
        expect(lobbyDocSchema.safeParse(toLobbySnapshot(state)).success).toBe(true);
        for (const effect of sim.effectsOf("gameFinished")) {
          expect(gameDocSchema.safeParse(effect.game).success).toBe(true);
          const scores = new Map(effect.game.players.map((player) => [player.playerId, player.score]));
          const correct = new Map<string, number>();
          for (const turn of effect.game.turns) {
            for (const question of turn.questions) {
              for (const answer of question.answers) {
                if (answer.correct) correct.set(answer.playerId, (correct.get(answer.playerId) ?? 0) + 1);
              }
            }
          }
          for (const [playerId, score] of scores) expect(score).toBe(correct.get(playerId) ?? 0);
        }
      }),
      { numRuns: 120 },
    );
  }, 120_000);

  it("ungestörte Spiele: R × P Züge, jede Person wählt genau einmal pro Runde in fester Reihenfolge", () => {
    fc.assert(
      fc.property(
        fc.record({
          seed: fc.integer(),
          humans: fc.integer({ min: 1, max: 5 }),
          bots: fc.integer({ min: 0, max: 3 }),
          rounds: fc.integer({ min: 1, max: 4 }),
          k: fc.integer({ min: 1, max: 4 }),
          accuracy: fc.double({ min: 0, max: 1, noNaN: true }),
        }),
        ({ seed, humans, bots, rounds, k, accuracy }) => {
          const sim = new Simulation({ seed, timing: "fast", catalog });
          for (let i = 1; i < humans; i++) sim.join(`Gast ${i}`);
          const botCount = Math.max(humans === 1 ? 1 : 0, Math.min(bots, 8 - humans));
          for (let i = 0; i < botCount; i++) sim.addBot();
          sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds, questionsPerCategory: k } });
          sim.ok({ type: "START", guestId: sim.host });
          const order = sim.state.game?.order ?? [];
          let counter = 0;
          sim.playToEnd((_guest, s) => {
            counter++;
            return (counter % 100) / 100 < accuracy ? s.correct : (((s.correct + 1) % 4) as AnswerIndex);
          });
          const game = sim.state.game;
          expect(sim.state.phase).toBe("game_over");
          expect(game?.turns).toHaveLength(rounds * order.length);
          for (let round = 1; round <= rounds; round++) {
            expect(game?.turns.filter((turn) => turn.round === round).map((turn) => turn.pickerId)).toEqual(order);
          }
          const questionIds =
            game?.turns.flatMap((turn) => turn.questions.map((question) => question.questionId)) ?? [];
          expect(questionIds).toHaveLength(rounds * order.length * k);
          expect(new Set(questionIds).size).toBe(questionIds.length);
          for (const turn of game?.turns ?? []) {
            const difficulties = turn.questions.map((question) => question.difficulty);
            expect(difficulties).toEqual([...difficulties].sort((a, b) => a - b));
          }
        },
      ),
      { numRuns: 60 },
    );
  }, 120_000);
});
