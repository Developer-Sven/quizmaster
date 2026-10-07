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
    const sim = lobbyWith(2);
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { answerSec: 0 } });
    toOpenQuestion(sim);
    const activity = sim.state.lastActivityAt;
    sim.ok({ type: "FREEZE" });
    expect(sim.state.lastActivityAt).toBe(activity);
    expect(errorCode(sim.dispatch({ type: "CONTINUE", guestId: sim.host, phase: "question" }))).toBe("INVALID_PHASE");
    sim.ok({ type: "END_GAME", guestId: sim.host });
    expect(sim.state.phase).toBe("game_over");
    expect(sim.state.frozen).toBeNull();
  });
});
