import { getTimings, type Phase } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import {
  currentQuestion,
  currentTurn,
  type LobbyState,
  SHELL_REQUEST_TIMEOUT_MS,
  toPrivateState,
  toPublicState,
} from "../src/index.ts";
import { lobbyWith, type Simulation } from "./support/simulation.ts";

const T = getTimings("normal");

function errorCode(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

function toPhase(sim: Simulation, phase: Phase): void {
  sim.runUntil((state) => state.phase === phase);
}

function pickerGuest(sim: Simulation): string {
  const turn = currentTurn(sim.state.game);
  if (!turn) throw new Error("Kein Zug");
  return sim.guestOf(turn.pickerId);
}

/** Erlaubte Übergänge (docs/02 §Zustandsautomat) inkl. vorzeitigem Spielende aus jeder Spielphase. */
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
  ...["intro", "category_pick", "question", "reveal", "turn_summary", "round_board"].map(
    (phase) => `${phase}>game_over`,
  ),
]);

describe("Zustandsautomat", () => {
  it("komplettes Spiel nutzt nur erlaubte Übergänge und endet in game_over", () => {
    const sim = lobbyWith(3, 1, { seed: "transitions" });
    const transitions = new Set<string>();
    let phase: Phase = sim.state.phase;
    const record = (state: LobbyState) => {
      if (state.phase !== phase) transitions.add(`${phase}>${state.phase}`);
      phase = state.phase;
    };
    sim.ok({ type: "START", guestId: sim.host });
    record(sim.state);
    for (let i = 0; i < 5_000 && sim.state.phase !== "game_over"; i++) {
      sim.fireNext();
      record(sim.state);
    }
    sim.ok({ type: "REMATCH", guestId: sim.host });
    record(sim.state);
    for (const transition of transitions) expect(ALLOWED.has(transition), transition).toBe(true);
    expect(transitions).toContain("round_board>game_over");
    expect(transitions).toContain("game_over>intro");
  });

  it("veraltetes TIMEOUT-Token wird ignoriert (gleicher Zustand, keine Effects)", () => {
    const sim = lobbyWith(2);
    sim.ok({ type: "START", guestId: sim.host });
    const introToken = sim.state.phaseToken;
    toPhase(sim, "category_pick");
    const before = sim.state;
    const result = sim.dispatch({ type: "TIMEOUT", token: introToken });
    expect(result).toEqual({ ok: true, state: before, effects: [] });
    expect(sim.dispatch({ type: "TIMEOUT", token: 999_999 })).toEqual({ ok: true, state: before, effects: [] });
  });

  it("Phasenlängen nach docs/05 (normal) inkl. Vorlauf 2.000/800 ms", () => {
    const sim = lobbyWith(2);
    sim.ok({ type: "START", guestId: sim.host });
    const span = (state: LobbyState) => (state.phaseEndsAt ?? 0) - state.phaseStartedAt;
    expect(span(sim.state)).toBe(T.introMs);
    toPhase(sim, "category_pick");
    expect(span(sim.state)).toBe(T.categoryPickMs);
    toPhase(sim, "question");
    const first = toPublicState(sim.state).question;
    expect((first?.startsAt ?? 0) - sim.state.phaseStartedAt).toBe(T.leadInFirstQuestionMs);
    expect((first?.deadline ?? 0) - (first?.startsAt ?? 0)).toBe(T.answerMs);
    expect(sim.state.phaseEndsAt).toBe(first?.deadline);
    toPhase(sim, "reveal");
    expect(sim.now).toBe((first?.deadline ?? 0) + T.deadlineGraceMs);
    expect(span(sim.state)).toBe(T.revealMs);
    toPhase(sim, "question");
    const second = toPublicState(sim.state).question;
    expect(second?.index).toBe(2);
    expect((second?.startsAt ?? 0) - sim.state.phaseStartedAt).toBe(T.leadInNextQuestionMs);
    toPhase(sim, "turn_summary");
    expect(span(sim.state)).toBe(T.turnSummaryMs);
    toPhase(sim, "round_board");
    expect(span(sim.state)).toBe(T.roundBoardMs);
  });

  it("fast-Timing (E2E) nutzt die kurzen Zeiten", () => {
    const sim = lobbyWith(2, 0, { timing: "fast" });
    sim.ok({ type: "START", guestId: sim.host });
    const fast = getTimings("fast");
    expect((sim.state.phaseEndsAt ?? 0) - sim.state.phaseStartedAt).toBe(fast.introMs);
    toPhase(sim, "question");
    const question = toPublicState(sim.state).question;
    expect((question?.deadline ?? 0) - (question?.startsAt ?? 0)).toBe(fast.answerMs);
  });
});

describe("Struktur: R Runden × P Züge × K Fragen", () => {
  it("jede aktive Person wählt genau einmal pro Runde, Reihenfolge ausgelost und in allen Runden gleich", () => {
    const sim = lobbyWith(4, 0, { seed: "structure" });
    sim.ok({ type: "START", guestId: sim.host });
    const order = toPublicState(sim.state).order ?? [];
    expect([...order].sort()).toEqual(sim.state.players.map((player) => player.playerId).sort());
    sim.playToEnd();
    const game = sim.state.game;
    if (!game) throw new Error("Kein Spiel");
    expect(game.turns).toHaveLength(3 * 4);
    for (let round = 1; round <= 3; round++) {
      expect(game.turns.filter((turn) => turn.round === round).map((turn) => turn.pickerId)).toEqual(order);
    }
    expect(game.turns.every((turn) => turn.questions.length === 3 && turn.questions.every((q) => q.outcomes))).toBe(
      true,
    );
    const pub = toPublicState(sim.state);
    expect(pub.order).toEqual(order);
    expect(pub.board).toHaveLength(12);
    // Gesamtzahl Fragen = Runden × Personen × Fragen pro Kategorie; nie doppelt.
    const ids = game.turns.flatMap((turn) => turn.questions.map((question) => question.questionId));
    expect(ids).toHaveLength(36);
    expect(new Set(ids).size).toBe(36);
  });

  it("die Reihenfolge wird je Spiel neu ausgelost", () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 12; seed++) {
      const sim = lobbyWith(4, 0, { seed });
      sim.ok({ type: "START", guestId: sim.host });
      orders.add(
        (toPublicState(sim.state).order ?? [])
          .map((id) => sim.state.players.findIndex((p) => p.playerId === id))
          .join(""),
      );
    }
    expect(orders.size).toBeGreaterThan(3);
  });

  it("Fortschritt: Runde x/R, Zug y/P", () => {
    const sim = lobbyWith(3);
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 2, questionsPerCategory: 1 } });
    sim.ok({ type: "START", guestId: sim.host });
    expect(toPublicState(sim.state).progress).toEqual({ round: 1, rounds: 2, turn: 1, turnsPerRound: 3 });
    toPhase(sim, "category_pick");
    expect(toPublicState(sim.state).progress).toEqual({ round: 1, rounds: 2, turn: 1, turnsPerRound: 3 });
    toPhase(sim, "turn_summary");
    toPhase(sim, "category_pick");
    expect(toPublicState(sim.state).progress).toEqual({ round: 1, rounds: 2, turn: 2, turnsPerRound: 3 });
    toPhase(sim, "round_board");
    expect(toPublicState(sim.state).progress).toEqual({ round: 1, rounds: 2, turn: 3, turnsPerRound: 3 });
    toPhase(sim, "category_pick");
    expect(toPublicState(sim.state).progress).toEqual({ round: 2, rounds: 2, turn: 1, turnsPerRound: 3 });
  });
});

describe("Kategoriewahl", () => {
  it("nur die wählende Person, nur eine der 3 Optionen, nur einmal", () => {
    const sim = lobbyWith(3);
    sim.ok({ type: "START", guestId: sim.host });
    toPhase(sim, "category_pick");
    const picker = pickerGuest(sim);
    const other = sim.guests.find((guest) => guest !== picker) ?? "";
    const turn = currentTurn(sim.state.game);
    const option = turn?.options[1]?.id ?? "";
    expect(toPrivateState(sim.state, sim.playerId(picker)).canPick).toBe(true);
    expect(toPrivateState(sim.state, sim.playerId(other)).canPick).toBe(false);
    expect(errorCode(sim.dispatch({ type: "PICK", guestId: other, categoryId: option }))).toBe("NOT_YOUR_TURN");
    const notOffered = sim.catalog.categories.find((category) => !turn?.options.some((o) => o.id === category.id));
    expect(errorCode(sim.dispatch({ type: "PICK", guestId: picker, categoryId: notOffered?.id ?? "" }))).toBe(
      "INVALID_OPTION",
    );
    expect(errorCode(sim.dispatch({ type: "PICK", guestId: picker, categoryId: "Ungültig!" }))).toBe(
      "VALIDATION_FAILED",
    );
    const result = sim.ok({ type: "PICK", guestId: picker, categoryId: option });
    // Wahl sofort sichtbar; Fragen werden geladen (Shell antwortet in der Simulation sofort).
    expect(result.effects).toContainEqual(
      expect.objectContaining({ type: "loadQuestions", categoryId: option, count: 3, excludeQuestionIds: [] }),
    );
    expect(currentTurn(sim.state.game)).toMatchObject({ categoryId: option, pickedBy: "player" });
    expect(sim.state.phase).toBe("question");
    expect(errorCode(sim.dispatch({ type: "PICK", guestId: picker, categoryId: option }))).toBe("INVALID_PHASE");
  });

  it("Zeit abgelaufen (oder wählende Person getrennt) → Zufall aus den drei", () => {
    const sim = lobbyWith(2, 0, { seed: "timeout-pick" });
    sim.ok({ type: "START", guestId: sim.host });
    toPhase(sim, "category_pick");
    sim.ok({ type: "DISCONNECT", guestId: pickerGuest(sim) });
    const turn = currentTurn(sim.state.game);
    const started = sim.state.phaseStartedAt;
    toPhase(sim, "question");
    expect(sim.state.phaseStartedAt).toBe(started + T.categoryPickMs);
    const picked = currentTurn(sim.state.game);
    expect(picked?.pickedBy).toBe("timeout");
    expect(turn?.options.map((option) => option.id)).toContain(picked?.categoryId);
  });

  it("veraltete oder ungültige Antworten der Shell", () => {
    const sim = lobbyWith(2, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.fireNext();
    const request = sim.requests[0];
    if (request?.kind !== "options") throw new Error("Anfrage fehlt");
    const options = sim.catalog.categories.slice(0, 3);
    const first = options[0];
    if (!first) throw new Error("Kategorie fehlt");
    expect(sim.dispatch({ type: "OPTIONS_READY", token: request.effect.token + 1, options }).ok).toBe(true);
    expect(sim.state.phase).toBe("intro");
    expect(
      errorCode(sim.dispatch({ type: "OPTIONS_READY", token: request.effect.token, options: [first, first, first] })),
    ).toBe("VALIDATION_FAILED");
    expect(
      errorCode(
        sim.dispatch({
          type: "OPTIONS_READY",
          token: request.effect.token,
          options: [{ ...first, extra: true } as typeof first, ...options.slice(1)],
        }),
      ),
    ).toBe("VALIDATION_FAILED");
    sim.respond();
    expect(sim.state.phase).toBe("category_pick");
  });

  it("wählende Person gibt auf → sofort Zufall; wartet die Shell auf ihre Kategorien → nächste Person", () => {
    const sim = lobbyWith(4, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.fireNext();
    const first = sim.requests[0];
    if (first?.kind !== "options") throw new Error("Anfrage fehlt");
    const firstPicker = first.effect.turn.pickerId;
    sim.ok({ type: "LEAVE", guestId: sim.guestOf(firstPicker) });
    const second = sim.requests[1];
    expect(second?.kind).toBe("options");
    if (second?.kind !== "options") throw new Error("Anfrage fehlt");
    expect(second.effect.turn.pickerId).not.toBe(firstPicker);
    // Alte Antwort ist jetzt veraltet.
    const stale = sim.respond(0);
    expect(stale.ok && stale.effects.length === 0).toBe(true);
    sim.respond(0);
    expect(sim.state.phase).toBe("category_pick");
    const picker = pickerGuest(sim);
    sim.ok({ type: "LEAVE", guestId: picker });
    expect(currentTurn(sim.state.game)?.pickedBy).toBe("timeout");
  });
});

describe("Antworten", () => {
  it("genau eine pro Person und Frage; TOO_EARLY vor startsAt; TOO_LATE nach deadline + 250 ms", () => {
    const sim = lobbyWith(3);
    sim.ok({ type: "START", guestId: sim.host });
    toPhase(sim, "question");
    const [a = "", b = "", c = ""] = sim.guests;
    expect(errorCode(sim.answer(a, 0))).toBe("TOO_EARLY");
    sim.toQuestionStart();
    expect(sim.answer(a, 1).ok).toBe(true);
    expect(errorCode(sim.answer(a, 2))).toBe("ALREADY_ANSWERED");
    const question = currentQuestion(sim.state.game);
    sim.now = (question?.deadline ?? 0) + T.deadlineGraceMs;
    expect(sim.answer(b, 1).ok).toBe(true);
    sim.now += 1;
    expect(errorCode(sim.answer(c, 1))).toBe("TOO_LATE");
    expect(errorCode(sim.dispatch({ type: "ANSWER", guestId: c, questionId: "unbekannt", choice: 0 }))).toBe(
      "INVALID_OPTION",
    );
    expect(errorCode(sim.dispatch({ type: "ANSWER", guestId: c, questionId: sim.questionId, choice: 7 as 0 }))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("Antwort auf eine aufgelöste Frage → TOO_LATE; außerhalb einer Frage → INVALID_PHASE", () => {
    const sim = lobbyWith(2);
    sim.ok({ type: "START", guestId: sim.host });
    toPhase(sim, "question");
    const questionId = sim.questionId;
    toPhase(sim, "reveal");
    const guest = sim.guests[0] ?? "";
    expect(errorCode(sim.dispatch({ type: "ANSWER", guestId: guest, questionId, choice: 0 }))).toBe("TOO_LATE");
    expect(errorCode(sim.dispatch({ type: "ANSWER", guestId: guest, questionId: "neu", choice: 0 }))).toBe(
      "INVALID_PHASE",
    );
  });

  it("Ack-relevantes Ergebnis verrät nichts: öffentlich nur „wer“, privat nur die eigene Wahl", () => {
    const sim = lobbyWith(2);
    sim.ok({ type: "START", guestId: sim.host });
    toPhase(sim, "question");
    sim.toQuestionStart();
    const [a = "", b = ""] = sim.guests;
    const result = sim.answer(a, 2);
    expect(result.ok).toBe(true);
    const pub = toPublicState(sim.state);
    expect(pub.question?.answeredBy).toEqual([sim.playerId(a)]);
    expect(pub.question && "correct" in pub.question).toBe(false);
    expect(toPrivateState(sim.state, sim.playerId(a)).myAnswer).toEqual({ questionId: sim.questionId, choice: 2 });
    expect(toPrivateState(sim.state, sim.playerId(b)).myAnswer).toBeNull();
    // Nur a bekommt ein privates Update, alle den öffentlichen Zustand.
    expect(result.effects.filter((effect) => effect.type === "sendPrivate")).toEqual([
      { type: "sendPrivate", playerId: sim.playerId(a), guestId: a },
    ]);
  });

  it("frühe Auflösung, sobald alle verbundenen Aktiven geantwortet haben (Getrennte zählen nicht)", () => {
    const sim = lobbyWith(3);
    sim.ok({ type: "START", guestId: sim.host });
    toPhase(sim, "question");
    const [a = "", b = "", c = ""] = sim.guests;
    sim.ok({ type: "DISCONNECT", guestId: c });
    sim.toQuestionStart();
    sim.answer(a, 0);
    const deadline = currentQuestion(sim.state.game)?.deadline ?? 0;
    expect(sim.state.phaseEndsAt).toBe(deadline);
    sim.advance(1_000);
    sim.answer(b, 1);
    expect(sim.state.phaseEndsAt).toBe(sim.now + T.earlyRevealMs);
    const answeredAt = sim.now;
    toPhase(sim, "reveal");
    expect(sim.now).toBe(answeredAt + T.earlyRevealMs);
  });

  it("Bots zählen bei der frühen Auflösung mit", () => {
    const sim = lobbyWith(1, 1);
    sim.ok({ type: "START", guestId: sim.host });
    toPhase(sim, "question");
    sim.toQuestionStart();
    sim.answer(sim.host, 0);
    // Bot hat noch nicht geantwortet → keine frühe Auflösung.
    expect(sim.state.phaseEndsAt).toBe(currentQuestion(sim.state.game)?.deadline);
    const botMove = sim.botMoves[0];
    expect(botMove?.command.type).toBe("ANSWER");
    sim.advance((botMove?.at ?? 0) - sim.now);
    expect(sim.state.phaseEndsAt).toBe((botMove?.at ?? 0) + T.earlyRevealMs);
  });

  it("keine Antwort = falsch (Tafel null, 0 Punkte); genau +1 pro richtiger Antwort", () => {
    const sim = lobbyWith(3, 0, { seed: "points" });
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 2, questionsPerCategory: 2 } });
    sim.ok({ type: "START", guestId: sim.host });
    const [a = "", b = "", c = ""] = sim.guests;
    sim.playToEnd((guest, s) => {
      if (guest === a) return s.correct;
      if (guest === b) return ((s.correct + 1) % 4) as 0 | 1 | 2 | 3;
      if (guest === c) return null;
      return null;
    });
    const pub = toPublicState(sim.state);
    const score = (guest: string) => pub.players.find((player) => player.id === sim.playerId(guest))?.score;
    expect(score(a)).toBe(2 * 3 * 2);
    expect(score(b)).toBe(0);
    expect(score(c)).toBe(0);
    for (const row of pub.board) {
      expect(row.results[sim.playerId(a)]).toEqual([true, true]);
      expect(row.results[sim.playerId(b)]).toEqual([false, false]);
      expect(row.results[sim.playerId(c)]).toEqual([null, null]);
    }
  });
});

describe("Aufgeben", () => {
  it("Züge der aufgegebenen Person entfallen in Folgerunden; Punkte bleiben sichtbar", () => {
    const sim = lobbyWith(3, 0, { seed: "resign" });
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 2, questionsPerCategory: 1 } });
    sim.ok({ type: "START", guestId: sim.host });
    const order = toPublicState(sim.state).order ?? [];
    // Erster Zug: alle antworten richtig; nach der Auflösung gibt die zuletzt wählende Person auf.
    toPhase(sim, "question");
    sim.toQuestionStart();
    for (const guest of sim.guests) sim.answer(guest, sim.correct);
    toPhase(sim, "reveal");
    const leaver = order[2] ?? "";
    sim.ok({ type: "LEAVE", guestId: sim.guestOf(leaver) });
    sim.playToEnd();
    const game = sim.state.game;
    expect(game?.turns.map((turn) => turn.pickerId)).toEqual([order[0], order[1], order[0], order[1]]);
    const pub = toPublicState(sim.state);
    expect(pub.players.find((player) => player.id === leaver)).toMatchObject({ status: "resigned", score: 1 });
    expect(pub.results?.ranking.at(-1)).toMatchObject({ playerId: leaver, status: "resigned", place: 3 });
  });

  it("weniger als 2 Aktive → sofort game_over mit Ergebnis (2 Personen: Sieg für die verbleibende)", () => {
    const sim = lobbyWith(2);
    sim.ok({ type: "START", guestId: sim.host });
    toPhase(sim, "question");
    const [a = "", b = ""] = sim.guests;
    const from = sim.effects.length;
    sim.ok({ type: "LEAVE", guestId: b });
    expect(sim.state.phase).toBe("game_over");
    expect(sim.state.game?.endReason).toBe("not_enough_players");
    const results = toPublicState(sim.state).results;
    expect(results).toEqual({
      outcome: "win",
      ranking: [
        { playerId: sim.playerId(a), place: 1, score: 0, status: "active" },
        { playerId: sim.playerId(b), place: 2, score: 0, status: "resigned" },
      ],
    });
    expect(sim.effectsOf("gameFinished", from)).toHaveLength(1);
    expect(sim.effectsOf("notice", from)).toEqual([{ type: "notice", code: "PLAYER_LEFT" }]);
  });

  it("Aufgeben während der Frage löst früh auf, wenn alle übrigen geantwortet haben", () => {
    const sim = lobbyWith(3);
    sim.ok({ type: "START", guestId: sim.host });
    toPhase(sim, "question");
    sim.toQuestionStart();
    const [a = "", b = "", c = ""] = sim.guests;
    sim.answer(a, 0);
    sim.answer(b, 0);
    sim.ok({ type: "LEAVE", guestId: c });
    expect(sim.state.phaseEndsAt).toBe(sim.now + T.earlyRevealMs);
  });
});

describe("Spielende und Revanche", () => {
  it("2 Personen gleichauf → draw", () => {
    const sim = lobbyWith(2);
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 1, questionsPerCategory: 1 } });
    sim.ok({ type: "START", guestId: sim.host });
    sim.playToEnd();
    expect(toPublicState(sim.state).results?.outcome).toBe("draw");
    expect(toPublicState(sim.state).results?.ranking.map((entry) => entry.place)).toEqual([1, 1]);
  });

  it("Revanche: nur Host, setzt Punkte/Tafel zurück, behält Einstellungen, lost neu, ohne Ausgetretene", () => {
    const sim = lobbyWith(4, 0, { seed: "rematch" });
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 1, questionsPerCategory: 2 } });
    sim.ok({ type: "START", guestId: sim.host });
    const firstOrder = toPublicState(sim.state).order;
    const firstGameId = sim.state.game?.gameId;
    sim.playToEnd();
    const leaver = sim.guests[3] ?? "";
    sim.ok({ type: "LEAVE", guestId: leaver });
    // In game_over bleibt die Person für das Ergebnis sichtbar.
    expect(toPublicState(sim.state).players).toHaveLength(4);
    expect(errorCode(sim.dispatch({ type: "REMATCH", guestId: sim.guests[1] ?? "" }))).toBe("NOT_HOST");
    const orders = new Set<string>([JSON.stringify(firstOrder)]);
    sim.ok({ type: "REMATCH", guestId: sim.host });
    const pub = toPublicState(sim.state);
    expect(pub.phase).toBe("intro");
    expect(pub.players).toHaveLength(3);
    expect(pub.players.every((player) => player.score === 0 && player.status === "active")).toBe(true);
    expect(pub.board).toEqual([]);
    expect(pub.results).toBeNull();
    expect(pub.settings).toEqual({ rounds: 1, questionsPerCategory: 2, maxPlayers: 8 });
    expect(sim.state.game?.gameId).not.toBe(firstGameId);
    expect([...(pub.order ?? [])].sort()).toEqual(pub.players.map((player) => player.id).sort());
    orders.add(JSON.stringify(pub.order));
    expect(errorCode(sim.dispatch({ type: "REMATCH", guestId: sim.host }))).toBe("INVALID_PHASE");
  });

  it("Revanche braucht ≥ 2 verbundene Personen", () => {
    const sim = lobbyWith(2);
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 1, questionsPerCategory: 1 } });
    sim.ok({ type: "START", guestId: sim.host });
    sim.playToEnd();
    sim.ok({ type: "DISCONNECT", guestId: sim.guests[1] ?? "" });
    expect(errorCode(sim.dispatch({ type: "REMATCH", guestId: sim.host }))).toBe("NOT_ENOUGH_PLAYERS");
  });

  it("LOAD_FAILED beendet das Spiel mit Ergebnis; veraltete Tokens werden ignoriert", () => {
    const sim = lobbyWith(2, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.fireNext();
    const request = sim.requests[0];
    if (request?.kind !== "options") throw new Error("Anfrage fehlt");
    expect(sim.dispatch({ type: "LOAD_FAILED", token: request.effect.token + 5, reason: "x" }).effects).toEqual([]);
    sim.ok({ type: "LOAD_FAILED", token: request.effect.token, reason: "keine Kategorien" });
    expect(sim.state.phase).toBe("game_over");
    expect(sim.state.game?.endReason).toBe("load_failed");
  });

  it("QUESTIONS_READY: validiert, verwirft Fremdfelder, sortiert leicht → schwer", () => {
    const sim = lobbyWith(2, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.fireNext();
    sim.respond();
    const picker = pickerGuest(sim);
    const option = currentTurn(sim.state.game)?.options[0]?.id ?? "";
    sim.ok({ type: "PICK", guestId: picker, categoryId: option });
    const request = sim.requests[0];
    if (request?.kind !== "questions") throw new Error("Anfrage fehlt");
    const docs = [...(sim.catalog.pool.get(option) ?? [])]
      .slice(0, 5)
      .map((entry) => sim.catalog.docs.get(entry.id))
      .filter((doc) => doc !== undefined);
    const token = request.effect.token;
    const [d1, d2, d3, d4] = docs;
    if (!d1 || !d2 || !d3 || !d4) throw new Error("Fixture");
    expect(errorCode(sim.dispatch({ type: "QUESTIONS_READY", token, questions: [d1, d2, d3, d4] }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(errorCode(sim.dispatch({ type: "QUESTIONS_READY", token, questions: [d1, d1] }))).toBe("VALIDATION_FAILED");
    const foreign = sim.catalog.docs.get(
      sim.catalog.pool.get(sim.catalog.categories.find((c) => c.id !== option)?.id ?? "")?.[0]?.id ?? "",
    );
    if (!foreign) throw new Error("Fixture");
    expect(errorCode(sim.dispatch({ type: "QUESTIONS_READY", token, questions: [foreign] }))).toBe("VALIDATION_FAILED");
    expect(
      errorCode(
        sim.dispatch({ type: "QUESTIONS_READY", token, questions: [{ ...d1, answers: ["a", "a", "b", "c"] }] }),
      ),
    ).toBe("VALIDATION_FAILED");
    sim.ok({ type: "QUESTIONS_READY", token, questions: [d3, d1, d2] });
    const questions = currentTurn(sim.state.game)?.questions ?? [];
    expect(questions.map((question) => question.difficulty)).toEqual(
      [d3, d1, d2].map((doc) => doc.difficulty).sort((x, y) => x - y),
    );
    for (const question of questions) {
      expect(question).not.toHaveProperty("source");
      expect(question).not.toHaveProperty("stats");
      expect(question.instanceId).not.toBe(question.questionId);
    }
    expect(sim.state.phase).toBe("question");
  });
});

describe("Randfälle", () => {
  it("Kategorie mit weniger als K unbenutzten Fragen: Zug mit weniger Fragen, Tafel passend", () => {
    const sim = lobbyWith(2, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.fireNext();
    sim.respond();
    const picker = pickerGuest(sim);
    const option = currentTurn(sim.state.game)?.options[0]?.id ?? "";
    sim.ok({ type: "PICK", guestId: picker, categoryId: option });
    const request = sim.requests[0];
    if (request?.kind !== "questions") throw new Error("Anfrage fehlt");
    const doc = sim.catalog.docs.get(sim.catalog.pool.get(option)?.[0]?.id ?? "");
    if (!doc) throw new Error("Fixture");
    sim.requests.length = 0;
    sim.ok({ type: "QUESTIONS_READY", token: request.effect.token, questions: [doc] });
    expect(toPublicState(sim.state).question).toMatchObject({ index: 1, total: 1 });
    toPhase(sim, "turn_summary");
    expect(toPublicState(sim.state).board[0]?.results[sim.playerId(picker)]).toEqual([null]);
  });

  it("LOAD_FAILED beim Laden der Fragen beendet das Spiel mit Ergebnis", () => {
    const sim = lobbyWith(2, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.fireNext();
    sim.respond();
    sim.ok({ type: "PICK", guestId: pickerGuest(sim), categoryId: currentTurn(sim.state.game)?.options[2]?.id ?? "" });
    const request = sim.requests[0];
    if (request?.kind !== "questions") throw new Error("Anfrage fehlt");
    sim.ok({ type: "LOAD_FAILED", token: request.effect.token, reason: "DB nicht erreichbar" });
    expect(sim.state.phase).toBe("game_over");
    expect(sim.state.game?.endReason).toBe("load_failed");
    expect(sim.effectsOf("gameFinished")).toHaveLength(1);
    // Die (jetzt veraltete) Antwort der Shell ändert nichts mehr.
    const before = sim.state;
    expect(sim.respond()).toEqual({ ok: true, state: before, effects: [] });
  });

  it("nach Spielende: Frist abgelaufen oder entfernt → nicht in der Revanche, Ergebnis bleibt sichtbar", () => {
    const sim = lobbyWith(4, 0, { seed: "after-game" });
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 1, questionsPerCategory: 1 } });
    sim.ok({ type: "START", guestId: sim.host });
    sim.playToEnd();
    const [, ben = "", lea = "", tom = ""] = sim.guests;
    const results = toPublicState(sim.state).results;
    sim.ok({ type: "DISCONNECT", guestId: ben });
    sim.advance(T.reconnectGameMs);
    expect(sim.state.players.find((player) => player.guestId === ben)?.left).toBe(true);
    expect(errorCode(sim.dispatch({ type: "RECONNECT", guestId: ben }))).toBe("LOBBY_NOT_FOUND");
    const from = sim.effects.length;
    sim.ok({ type: "KICK", guestId: sim.host, targetPlayerId: sim.playerId(lea) });
    expect(sim.effectsOf("kick", from)).toHaveLength(1);
    expect(toPublicState(sim.state).results).toEqual(results);
    expect(toPublicState(sim.state).players).toHaveLength(4);
    sim.ok({ type: "REMATCH", guestId: sim.host });
    expect(sim.state.players.map((player) => player.guestId)).toEqual([sim.host, tom]);
    expect(errorCode(sim.dispatch({ type: "RECONNECT", guestId: lea }))).toBe("KICKED");
  });
});

describe("Anfragen an die Shell: Frist (Watchdog)", () => {
  function requestTimers(sim: Simulation) {
    return sim.state.timers.filter((timer) => timer.kind === "request");
  }

  it("OPTIONS_READY bleibt aus → nach SHELL_REQUEST_TIMEOUT_MS game_over (load_failed), späte Antwort veraltet", () => {
    const sim = lobbyWith(2, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.fireNext();
    expect(sim.state.game?.pending?.kind).toBe("options");
    expect(SHELL_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    const [timer] = requestTimers(sim);
    expect(timer?.at).toBe(sim.now + SHELL_REQUEST_TIMEOUT_MS);
    sim.advance(SHELL_REQUEST_TIMEOUT_MS - 1);
    expect(sim.state.phase).toBe("intro");
    sim.advance(1);
    expect(sim.state.phase).toBe("game_over");
    expect(sim.state.game?.endReason).toBe("load_failed");
    expect(sim.state.game?.pending).toBeNull();
    expect(sim.effectsOf("gameFinished")).toHaveLength(1);
    const before = sim.state;
    expect(sim.respond()).toEqual({ ok: true, state: before, effects: [] });
  });

  it("abgelehnte QUESTIONS_READY hält die Anfrage nur bis zur Frist offen – danach game_over", () => {
    const sim = lobbyWith(2, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.fireNext();
    sim.respond();
    const option = currentTurn(sim.state.game)?.options[0]?.id ?? "";
    sim.ok({ type: "PICK", guestId: pickerGuest(sim), categoryId: option });
    const request = sim.requests[0];
    if (request?.kind !== "questions") throw new Error("Anfrage fehlt");
    const doc = sim.catalog.docs.get(sim.catalog.pool.get(option)?.[0]?.id ?? "");
    if (!doc) throw new Error("Fixture");
    const broken = { ...doc, answers: ["a", "a", "b", "c"] as typeof doc.answers };
    expect(errorCode(sim.dispatch({ type: "QUESTIONS_READY", token: request.effect.token, questions: [broken] }))).toBe(
      "VALIDATION_FAILED",
    );
    expect(sim.state.game?.pending?.kind).toBe("questions");
    sim.advance(60_000);
    expect(sim.state.phase).toBe("game_over");
    expect(sim.state.game?.endReason).toBe("load_failed");
    expect(sim.timers.size).toBe(sim.state.timers.length);
  });

  it("rechtzeitige Antwort räumt die Frist ab (cancelTimer); das Spiel läuft über die Frist hinaus weiter", () => {
    const sim = lobbyWith(2, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.fireNext();
    const [timer] = requestTimers(sim);
    if (!timer) throw new Error("Frist fehlt");
    const from = sim.effects.length;
    sim.respond();
    expect(requestTimers(sim)).toEqual([]);
    expect(sim.effectsOf("cancelTimer", from)).toContainEqual({ type: "cancelTimer", token: timer.token });
    expect(sim.dispatch({ type: "TIMEOUT", token: timer.token })).toMatchObject({ ok: true, effects: [] });
    // Kategoriewahl per Zeitablauf → neue Anfrage (Fragen) mit eigener Frist.
    sim.advance(T.categoryPickMs);
    expect(sim.state.game?.pending?.kind).toBe("questions");
    expect(requestTimers(sim)).toHaveLength(1);
    sim.respond();
    expect(requestTimers(sim)).toEqual([]);
    sim.advance(SHELL_REQUEST_TIMEOUT_MS);
    expect(sim.state.game?.endReason).not.toBe("load_failed");
  });

  it("jede neue Anfrage bekommt die volle Frist (Aufgeben der wählenden Person während der Anfrage)", () => {
    const sim = lobbyWith(4, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.fireNext();
    const first = sim.requests[0];
    if (first?.kind !== "options") throw new Error("Anfrage fehlt");
    sim.advance(10_000);
    sim.ok({ type: "LEAVE", guestId: sim.guestOf(first.effect.turn.pickerId) });
    const pending = sim.state.game?.pending;
    expect(pending?.kind).toBe("options");
    expect(pending?.token).not.toBe(first.effect.token);
    expect(requestTimers(sim)).toHaveLength(1);
    sim.advance(SHELL_REQUEST_TIMEOUT_MS - 10_000);
    expect(sim.state.phase).toBe("intro");
    sim.advance(10_000);
    expect(sim.state.phase).toBe("game_over");
    expect(sim.state.game?.endReason).toBe("load_failed");
  });

  it("LOAD_FAILED und Spielende räumen die Frist ab", () => {
    const sim = lobbyWith(2, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.fireNext();
    const request = sim.requests[0];
    if (request?.kind !== "options") throw new Error("Anfrage fehlt");
    sim.ok({ type: "LOAD_FAILED", token: request.effect.token, reason: "Test" });
    expect(sim.state.phase).toBe("game_over");
    expect(requestTimers(sim)).toEqual([]);
  });
});
