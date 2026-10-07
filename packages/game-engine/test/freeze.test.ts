import { TIMINGS } from "@quizmaster/shared";
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
  it("Antwortzeiten bleiben über das Einfrieren gleich – vorher gegebene Antworten rücken mit (Spielarchiv)", () => {
    const sim = lobbyWith(2);
    const [host = "", ben = ""] = sim.guests;
    toOpenQuestion(sim);
    sim.advance(2_000);
    expect(sim.answer(ben, sim.correct).ok).toBe(true);
    // Rückwirkend nie vor die letzte Antwort einfrieren, auch wenn das gemeldete Lebenszeichen älter ist.
    sim.ok({ type: "FREEZE", since: sim.now - 5_000 });
    sim.advance(60_000);
    sim.ok({ type: "THAW" });
    sim.advance(1_000);
    expect(sim.answer(host, sim.correct).ok).toBe(true);
    sim.runUntil((state) => state.phase === "reveal");
    const outcomes = currentQuestion(sim.state.game)?.outcomes ?? [];
    const byGuest = (guestId: string) =>
      outcomes.find((entry) => entry.playerId === sim.state.players.find((p) => p.guestId === guestId)?.playerId);
    expect(byGuest(ben)?.ms).toBe(2_000);
    expect(byGuest(host)?.ms).toBe(3_000);
  });

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

/**
 * Gestaffelte Rückkehr nach einem Aussetzer (ADR-060): Dauert er länger als das Ping-Timeout, trennt der Server
 * alle Geräte. Kommt das Netz zurück, verbinden sie sich nacheinander (Backoff je Gerät 1–5 s, dazu Ticket und
 * Handshake). Wer im Aussetzer getrennt wurde, gilt nach dem Auftauen noch `reconnectHoldMs` lang als „gleich wieder
 * da“: Die erste zurückkehrende Person löst die Frage nicht für alle auf und wird nicht an Stelle des Hosts Host.
 */
describe("Schonfrist nach dem Auftauen (ADR-060)", () => {
  const holdMs = TIMINGS.normal.reconnectHoldMs;

  /** Frage offen, Host und Ben haben geantwortet, Lea nicht; dann Aussetzer: eingefroren, alle getrennt. */
  function outageAfterAnswers(): { sim: Simulation; ben: string; lea: string } {
    const sim = lobbyWith(3);
    const ben = sim.guests[1] ?? "";
    const lea = sim.guests[2] ?? "";
    toOpenQuestion(sim);
    expect(sim.answer(sim.host, sim.correct).ok).toBe(true);
    expect(sim.answer(ben, sim.correct).ok).toBe(true);
    sim.ok({ type: "FREEZE" });
    // Ping-Timeout: Socket.IO trennt alle Geräte gut 20 s nach dem letzten Lebenszeichen.
    sim.advance(20_000);
    for (const guest of [sim.host, ben, lea]) sim.ok({ type: "DISCONNECT", guestId: guest });
    sim.advance(20_000);
    return { sim, ben, lea };
  }

  it("die erste zurückkehrende Person löst nicht für alle auf – wer gleich nachkommt, beantwortet die Frage noch", () => {
    const { sim, ben, lea } = outageAfterAnswers();
    // Das Netz ist zurück: Der Host verbindet sich als Erster, sein Kommando taut auf.
    sim.ok({ type: "RECONNECT", guestId: sim.host });
    expect(sim.state.frozen).toBeNull();
    sim.advance(1_500);
    expect(sim.state.phase).toBe("question");
    sim.ok({ type: "RECONNECT", guestId: ben });
    sim.advance(1_500);
    expect(sim.state.phase).toBe("question");
    sim.ok({ type: "RECONNECT", guestId: lea });
    expect(sim.answer(lea, sim.correct).ok).toBe(true);
    // Jetzt haben alle geantwortet: frühe Auflösung wie gewohnt.
    const answeredAt = sim.now;
    sim.runUntil((state) => state.phase === "reveal");
    expect(sim.now).toBeLessThanOrEqual(answeredAt + TIMINGS.normal.earlyRevealMs);
    const outcomes = currentQuestion(sim.state.game)?.outcomes ?? [];
    expect(outcomes.find((entry) => entry.playerId === sim.playerId(lea))?.correct).toBe(true);
    expect(sim.state.reconnectHold).toBeNull();
  });

  it("wer in der Schonfrist nicht zurückkommt, zählt danach wieder als getrennt – Auflösung ohne sie", () => {
    const { sim, ben } = outageAfterAnswers();
    sim.ok({ type: "RECONNECT", guestId: sim.host });
    const thawedAt = sim.now;
    const deadline = currentQuestion(sim.state.game)?.deadline ?? 0;
    sim.ok({ type: "RECONNECT", guestId: ben });
    // Lea bleibt weg: Die Frage wartet die Schonfrist ab, nicht bis zum (verschobenen) Antwortschluss.
    sim.runUntil((state) => state.phase === "reveal");
    expect(sim.now).toBeGreaterThanOrEqual(thawedAt + holdMs);
    expect(sim.now).toBeLessThanOrEqual(thawedAt + holdMs + TIMINGS.normal.earlyRevealMs);
    expect(sim.now).toBeLessThan(deadline);
    expect(sim.state.reconnectHold).toBeNull();
  });

  it("nur wer im Aussetzer getrennt wurde: Wer schon vorher weg war, hält die Frage nicht auf", () => {
    const sim = lobbyWith(3);
    const ben = sim.guests[1] ?? "";
    const lea = sim.guests[2] ?? "";
    toOpenQuestion(sim);
    expect(sim.answer(ben, sim.correct).ok).toBe(true);
    // Lea schließt die App vor dem Aussetzer (eigene Trennung, wie ohne Aussetzer).
    sim.ok({ type: "DISCONNECT", guestId: lea });
    sim.advance(2_000);
    sim.ok({ type: "FREEZE" });
    sim.advance(20_000);
    for (const guest of [sim.host, ben]) sim.ok({ type: "DISCONNECT", guestId: guest });
    sim.advance(10_000);
    sim.ok({ type: "RECONNECT", guestId: sim.host });
    expect(sim.state.reconnectHold?.playerIds).toEqual([sim.playerId(ben)]);
    // Ben hat schon geantwortet: Mit der Antwort des Hosts haben alle geantwortet, die zählen.
    expect(sim.answer(sim.host, sim.correct).ok).toBe(true);
    sim.advance(TIMINGS.normal.earlyRevealMs);
    expect(sim.state.phase).toBe("reveal");
  });

  it("die Host-Rolle geht in der Schonfrist nicht an die erste zurückkehrende Person", () => {
    const sim = lobbyWith(3);
    const ben = sim.guests[1] ?? "";
    const lea = sim.guests[2] ?? "";
    const host = sim.host;
    const hostId = sim.state.hostPlayerId;
    toOpenQuestion(sim);
    sim.ok({ type: "FREEZE" });
    sim.advance(20_000);
    for (const guest of [host, ben, lea]) sim.ok({ type: "DISCONNECT", guestId: guest });
    // Länger getrennt als die Host-Übergabe (30 s) – ohne Schonfrist würde Ben sofort Host.
    sim.advance(TIMINGS.normal.hostHandoverMs + 5_000);
    sim.ok({ type: "RECONNECT", guestId: ben });
    expect(sim.state.hostPlayerId).toBe(hostId);
    sim.advance(holdMs - 1_000);
    expect(sim.state.hostPlayerId).toBe(hostId);
    sim.ok({ type: "RECONNECT", guestId: host });
    sim.advance(holdMs);
    expect(sim.state.hostPlayerId).toBe(hostId);
  });

  it("kommt der Host in der Schonfrist nicht zurück, übernimmt danach die am längsten anwesende verbundene Person", () => {
    const sim = lobbyWith(3);
    const ben = sim.guests[1] ?? "";
    const lea = sim.guests[2] ?? "";
    toOpenQuestion(sim);
    sim.ok({ type: "FREEZE" });
    sim.advance(20_000);
    for (const guest of [sim.host, ben, lea]) sim.ok({ type: "DISCONNECT", guestId: guest });
    sim.advance(TIMINGS.normal.hostHandoverMs + 5_000);
    sim.ok({ type: "RECONNECT", guestId: lea });
    const thawedAt = sim.now;
    sim.ok({ type: "RECONNECT", guestId: ben });
    sim.advance(holdMs - 1);
    expect(sim.state.hostPlayerId).not.toBe(sim.playerId(ben));
    // Der Timer der Übergabe liegt auf dem Ende der Schonfrist.
    sim.advance(1);
    expect(sim.now).toBe(thawedAt + holdMs);
    expect(sim.state.hostPlayerId).toBe(sim.playerId(ben));
  });

  it("beginnt im Einfrieren eine neue Phase, zählen auch die vorher im Aussetzer Getrennten", () => {
    // Die Shell liefert die Fragen erst im Einfrieren: Die Frage beginnt angehalten (ab ihrem Beginn) – getrennt
    // wurden alle schon vorher, aber erst im Aussetzer.
    const sim = lobbyWith(3, 0, { autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.runUntil(() => sim.requests.length > 0);
    sim.respond();
    const turn = sim.state.game?.turns.at(-1);
    const categoryId = turn?.options[0]?.id ?? "";
    sim.ok({ type: "PICK", guestId: sim.guestOf(turn?.pickerId ?? ""), categoryId });
    sim.ok({ type: "FREEZE" });
    sim.advance(18_000);
    const [first, ...rest] = sim.guests;
    for (const guest of sim.guests) sim.ok({ type: "DISCONNECT", guestId: guest });
    sim.advance(1_000);
    sim.respond();
    expect(sim.state.phase).toBe("question");
    expect(sim.state.frozen?.since).toBe(sim.now);
    sim.ok({ type: "RECONNECT", guestId: first ?? "" });
    expect([...(sim.state.reconnectHold?.playerIds ?? [])].sort()).toEqual(
      rest.map((guest) => sim.playerId(guest)).sort(),
    );
  });
});
