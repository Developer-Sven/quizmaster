import { describe, expect, it } from "vitest";
import { currentQuestion, toPublicState } from "../src/index.ts";
import { lobbyWith, type Simulation } from "./support/simulation.ts";

function errorCode(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

function toOpenQuestion(sim: Simulation): void {
  sim.ok({ type: "START", guestId: sim.host });
  sim.runUntil((state) => state.phase === "question");
  sim.toQuestionStart();
}

describe("Netzaussetzer: Spiel einfrieren und auftauen (ADR-057)", () => {
  it("die Spielzeit steht; beim Auftauen rücken Frage, Phase und Timer um die Pause nach hinten", () => {
    const sim = lobbyWith(2);
    const ben = sim.guests[1] ?? "";
    toOpenQuestion(sim);
    sim.advance(2_000);
    const question = currentQuestion(sim.state.game);
    const { phaseStartedAt, phaseEndsAt } = sim.state;
    sim.ok({ type: "FREEZE" });
    expect(toPublicState(sim.state).frozen).toBe(true);
    // Weit über den Antwortschluss hinaus passiert nichts.
    sim.advance(60_000);
    expect(sim.state.phase).toBe("question");
    sim.ok({ type: "THAW" });
    expect(toPublicState(sim.state).frozen).toBe(false);
    expect(currentQuestion(sim.state.game)?.startsAt).toBe((question?.startsAt ?? 0) + 60_000);
    expect(currentQuestion(sim.state.game)?.deadline).toBe((question?.deadline ?? 0) + 60_000);
    expect(sim.state.phaseStartedAt).toBe(phaseStartedAt + 60_000);
    expect(sim.state.phaseEndsAt).toBe((phaseEndsAt ?? 0) + 60_000);
    // Eine Antwort nach dem Auftauen zählt – niemand verliert die Frage an die Leitung.
    expect(sim.answer(ben, sim.correct).ok).toBe(true);
    // Danach läuft die Phase mit ihrer Restzeit normal aus.
    sim.runUntil((state) => state.phase === "reveal");
    expect(sim.now).toBeGreaterThanOrEqual((question?.deadline ?? 0) + 60_000);
  });

  it("rückwirkend ab dem letzten Lebenszeichen – die Sekunden bis zum Bemerken kommen zurück, nie vor die Phase", () => {
    const sim = lobbyWith(2);
    toOpenQuestion(sim);
    const heard = sim.now;
    const deadline = currentQuestion(sim.state.game)?.deadline ?? 0;
    // Die Stille fällt erst nach 8 s auf.
    sim.advance(8_000);
    sim.ok({ type: "FREEZE", since: heard });
    sim.advance(20_000);
    sim.ok({ type: "THAW" });
    expect(currentQuestion(sim.state.game)?.deadline).toBe(deadline + 28_000);
    // Lebenszeichen vor der laufenden Phase: höchstens ab Phasenbeginn.
    const other = lobbyWith(2);
    toOpenQuestion(other);
    const started = other.state.phaseStartedAt;
    other.ok({ type: "FREEZE", since: started - 60_000 });
    expect(other.state.frozen?.since).toBe(started);
  });

  it("nur im laufenden Spiel, nie doppelt; Auftauen ohne Einfrieren ändert nichts", () => {
    const sim = lobbyWith(2);
    const lobbyRev = sim.state.rev;
    sim.ok({ type: "FREEZE" });
    sim.ok({ type: "THAW" });
    expect(sim.state.rev).toBe(lobbyRev);
    expect(sim.state.frozen).toBeNull();
    toOpenQuestion(sim);
    sim.ok({ type: "FREEZE" });
    const since = sim.state.frozen?.since;
    sim.advance(5_000);
    sim.ok({ type: "FREEZE" });
    expect(sim.state.frozen?.since).toBe(since);
  });

  it("eingefroren kein „Weiter“; Spielende hebt das Einfrieren auf; zählt nicht als Aktivität", () => {
    // Anzeigender Host (ADR-046): Er zählt nicht zu den Aktiven, sein Paket taut also nicht auf.
    const sim = lobbyWith(3);
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { answerSec: 0, hostPlays: false } });
    toOpenQuestion(sim);
    const activity = sim.state.lastActivityAt;
    sim.ok({ type: "FREEZE" });
    expect(sim.state.lastActivityAt).toBe(activity);
    expect(errorCode(sim.dispatch({ type: "CONTINUE", guestId: sim.host, phase: "question" }))).toBe("INVALID_PHASE");
    expect(sim.state.frozen).not.toBeNull();
    sim.ok({ type: "END_GAME", guestId: sim.host });
    expect(sim.state.phase).toBe("game_over");
    expect(sim.state.frozen).toBeNull();
  });

  it("ein Kommando einer aktiven Person taut zuerst auf – ihre Antwort zählt gegen die verschobene Frist", () => {
    // Auch über einen Socket, der (noch) nicht an die Lobby gebunden ist: Wer etwas schickt, ist zu hören.
    const sim = lobbyWith(2);
    const ben = sim.guests[1] ?? "";
    toOpenQuestion(sim);
    const deadline = currentQuestion(sim.state.game)?.deadline ?? 0;
    sim.ok({ type: "FREEZE" });
    sim.advance(45_000);
    expect(sim.now).toBeGreaterThan(deadline);
    expect(sim.answer(ben, sim.correct).ok).toBe(true);
    expect(sim.state.frozen).toBeNull();
    expect(currentQuestion(sim.state.game)?.deadline).toBe(deadline + 45_000);
    // Der aktive Host darf danach auflösen lassen wie gewohnt – sein Paket hätte ebenso aufgetaut.
    sim.ok({ type: "FREEZE" });
    expect(sim.answer(sim.host, sim.correct).ok).toBe(true);
    expect(sim.state.frozen).toBeNull();
  });

  it("eine Trennung im Einfrieren löst die Frage nicht vorzeitig auf (gestaffelte Ping-Timeouts)", () => {
    const sim = lobbyWith(3);
    const ben = sim.guests[1] ?? "";
    const lea = sim.guests[2] ?? "";
    toOpenQuestion(sim);
    expect(sim.answer(sim.host, sim.correct).ok).toBe(true);
    expect(sim.answer(ben, sim.correct).ok).toBe(true);
    sim.ok({ type: "FREEZE" });
    // Socket.IO trennt Lea gut 20 s nach dem letzten Pong – alle anderen haben schon geantwortet.
    sim.advance(20_000);
    sim.ok({ type: "DISCONNECT", guestId: lea });
    sim.advance(30_000);
    expect(sim.state.phase).toBe("question");
    expect(currentQuestion(sim.state.game)?.outcomes).toBeNull();
    expect(sim.state.frozen).not.toBeNull();
    expect([...sim.timers.values()].filter((timer) => timer.kind === "phase")).toEqual([]);
    // Lea kommt zurück (ihr Paket taut auf) und beantwortet die Frage noch.
    sim.ok({ type: "RECONNECT", guestId: lea });
    expect(sim.state.frozen).toBeNull();
    expect(sim.answer(lea, sim.correct).ok).toBe(true);
    sim.runUntil((state) => state.phase === "reveal");
    const outcomes = currentQuestion(sim.state.game)?.outcomes ?? [];
    expect(outcomes.find((entry) => entry.playerId === sim.playerId(lea))?.correct).toBe(true);
  });

  it("eine im Einfrieren begonnene Phase startet angehalten; nach dem Auftauen genau ein Phasen-Timer", () => {
    // Die Reconnect-Frist läuft weiter (ADR-057): Die wählende Person scheidet aus, die Zufallswahl lädt die Fragen.
    const sim = lobbyWith(3);
    sim.ok({ type: "START", guestId: sim.host });
    sim.runUntil((state) => state.phase === "category_pick");
    const pickerId = sim.state.game?.turns.at(-1)?.pickerId ?? "";
    sim.ok({ type: "FREEZE" });
    sim.ok({ type: "DISCONNECT", guestId: sim.guestOf(pickerId) });
    sim.advance(90_001);
    expect(sim.state.phase).toBe("question");
    expect(sim.state.frozen).not.toBeNull();
    expect(sim.state.frozen?.since).toBe(sim.state.phaseStartedAt);
    expect([...sim.timers.values()].filter((timer) => timer.kind === "phase")).toEqual([]);
    const presented = currentQuestion(sim.state.game);
    const { phaseStartedAt } = sim.state;
    sim.advance(10_000);
    expect(sim.state.phase).toBe("question");
    sim.ok({ type: "THAW" });
    // Die Frage rückt um die Zeit seit ihrem Beginn nach hinten, nicht um die ganze Pause.
    const pausedMs = sim.now - phaseStartedAt;
    expect(pausedMs).toBeLessThan(11_000);
    const question = currentQuestion(sim.state.game);
    expect(question?.startsAt).toBe((presented?.startsAt ?? 0) + pausedMs);
    expect(question?.deadline).toBe((presented?.deadline ?? 0) + pausedMs);
    expect(sim.state.phaseStartedAt).toBe(phaseStartedAt + pausedMs);
    const phaseTimers = [...sim.timers.values()].filter((timer) => timer.kind === "phase");
    expect(phaseTimers).toHaveLength(1);
    expect(phaseTimers[0]?.at).toBeGreaterThan(question?.deadline ?? 0);
    // Die ganze Frage bleibt: Vorlauf, dann volle Antwortzeit.
    sim.toQuestionStart();
    const someone = sim.state.players.find((player) => player.status === "active" && !player.isBot);
    expect(sim.answer(someone?.guestId ?? "", sim.correct).ok).toBe(true);
  });

  it("eine Kategoriewahl im Einfrieren lässt keinen angehaltenen Wahl-Timer zurück", () => {
    const sim = lobbyWith(3, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.runUntil(() => sim.requests.length > 0);
    sim.respond();
    expect(sim.state.phase).toBe("category_pick");
    const pickerId = sim.state.game?.turns.at(-1)?.pickerId ?? "";
    sim.ok({ type: "FREEZE" });
    expect(sim.state.frozen?.phaseTimerAt).not.toBeNull();
    // Die wählende Person scheidet im Einfrieren aus (Reconnect-Frist) → Zufallswahl, Fragen werden geladen.
    sim.ok({ type: "DISCONNECT", guestId: sim.guestOf(pickerId) });
    sim.advance(90_001);
    expect(sim.state.game?.turns.at(-1)?.categoryId).not.toBeNull();
    expect(sim.state.frozen).not.toBeNull();
    expect(sim.state.frozen?.phaseTimerAt).toBeNull();
    sim.ok({ type: "THAW" });
    expect([...sim.timers.values()].filter((timer) => timer.kind === "phase")).toEqual([]);
  });
});
