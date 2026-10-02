/**
 * Wiederaufnahme aus Lobby-Snapshots (docs/07 Checkliste Phase 6): `toLobbySnapshot` → (Datenbank) →
 * `fromLobbySnapshot`. Geprüft wird das Zurücksetzen jeder Phase, dass Punkte aufgelöster Fragen erhalten
 * bleiben, dass das Spiel danach regulär weiterläuft, und dass ungültige Dokumente sauber abgelehnt werden.
 */
import { findKeysDeep, getTimings, PRE_REVEAL_FORBIDDEN_KEYS, publicLobbyStateSchema } from "@quizmaster/shared";
import { lobbyDocSchema } from "@quizmaster/shared/documents";
import { describe, expect, it } from "vitest";
import { lobbyWith, type Simulation } from "../test/support/simulation.ts";
import {
  computeScores,
  currentQuestion,
  currentTurn,
  fromLobbySnapshot,
  GAME_SNAPSHOT_VERSION,
  type LobbyState,
  planBotMoves,
  reduce,
  toLobbySnapshot,
  toPublicState,
} from "./index.ts";

const normal = getTimings("normal");
const GRACE = 5_000;

/** Snapshot wie aus MongoDB zurückgelesen (Dates bleiben Dates). */
function roundTrip(state: LobbyState) {
  const doc = structuredClone(toLobbySnapshot(state));
  expect(lobbyDocSchema.safeParse(doc).success).toBe(true);
  return doc;
}

function restore(state: LobbyState, now: number, graceMs = GRACE) {
  const result = fromLobbySnapshot(roundTrip(state), { now, timing: state.timing, graceMs });
  if (!result.ok) throw new Error(`nicht wiederherstellbar: ${result.reason}`);
  return result;
}

/** Übernimmt einen wiederhergestellten Zustand in die Simulation (wie `LobbyActor.resume`). */
function adopt(sim: Simulation, state: LobbyState, now: number): void {
  sim.state = state;
  sim.now = now;
  sim.timers.clear();
  for (const timer of state.timers)
    sim.timers.set(timer.token, { at: timer.at, kind: timer.kind, playerId: timer.playerId });
  sim.botMoves = planBotMoves(state, sim.rng);
}

function reconnectAll(sim: Simulation): void {
  for (const player of sim.state.players) {
    if (!player.isBot && !player.left) sim.ok({ type: "RECONNECT", guestId: player.guestId });
  }
}

describe("fromLobbySnapshot – Lobby", () => {
  it("nimmt eine wartende Lobby mit Einstellungen, Host, Sperren und Fristen wieder auf", () => {
    const sim = lobbyWith(3, 1, { seed: "resume-lobby" });
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 2, questionsPerCategory: 2 } });
    const kicked = sim.join("Ole");
    sim.ok({ type: "KICK", guestId: sim.host, targetPlayerId: sim.playerId(kicked) });
    const now = sim.now + 4_000;
    const { state, reset } = restore(sim.state, now);

    expect(reset).toBe("none");
    expect(state.phase).toBe("lobby");
    expect(state.rev).toBe(sim.state.rev + 1);
    expect(state.settings).toEqual(sim.state.settings);
    expect(state.hostPlayerId).toBe(sim.state.hostPlayerId);
    expect(state.bannedGuestIds).toEqual([kicked]);
    expect(state.timing).toBe("normal");
    for (const player of state.players) {
      expect(player.connected).toBe(player.isBot);
      expect(player.disconnectedAt).toBe(player.isBot ? null : now);
      expect(player.left).toBe(false);
    }
    const kinds = state.timers.map((timer) => `${timer.kind}@${timer.at - now}`).sort();
    expect(kinds).toEqual(
      [
        ...Array.from({ length: 3 }, () => `reconnect@${normal.reconnectLobbyMs}`),
        `host_handover@${normal.hostHandoverMs}`,
        `empty_close@${normal.emptyLobbyCloseMs}`,
        `idle_close@${sim.state.lastActivityAt + 30 * 60_000 - now}`,
      ].sort(),
    );
    // Rückkehr: RECONNECT holt Person und Socket-Zustand zurück.
    const back = reduce(state, { type: "RECONNECT", guestId: sim.host }, { now: now + 500, rng: sim.rng });
    expect(back.ok && back.effects.some((effect) => effect.type === "broadcast")).toBe(true);
    expect(fromLobbySnapshot(roundTrip(sim.state), { now, timing: "fast" }).ok).toBe(true);
  });
});

describe("fromLobbySnapshot – laufendes Spiel", () => {
  it("setzt eine Frage auf ihren Anfang zurück, erhält Punkte und spielt danach regulär weiter", () => {
    const sim = lobbyWith(2, 0, { seed: "resume-question" });
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 1, questionsPerCategory: 3 } });
    sim.ok({ type: "START", guestId: sim.host });
    const [host, guest] = [sim.host, sim.guests[1] ?? ""];
    // Frage 1: Host richtig, Gast falsch → aufgelöst; dann Frage 2 starten, Host antwortet schon.
    sim.runUntil((state) => state.phase === "question");
    sim.toQuestionStart();
    sim.answer(host, sim.correct);
    sim.answer(guest, ((sim.correct + 1) % 4) as 0 | 1 | 2 | 3);
    sim.runUntil((state) => state.phase === "question" && (currentTurn(state.game)?.currentIndex ?? 0) === 1);
    sim.toQuestionStart();
    sim.answer(host, sim.correct);
    const before = sim.state;
    const instanceId = currentQuestion(before.game)?.instanceId;
    const scoresBefore = computeScores(before.game);
    expect(scoresBefore.get(sim.playerId(host))).toBe(1);

    const now = sim.now + 7_000;
    const { state, reset } = restore(before, now);
    expect(reset).toBe("question_restarted");
    expect(state.phase).toBe("question");
    const question = currentQuestion(state.game);
    expect(question?.instanceId).toBe(instanceId);
    expect(question?.responses).toEqual([]);
    expect(question?.startsAt).toBe(now + GRACE + normal.leadInNextQuestionMs);
    expect(question?.deadline).toBe((question?.startsAt ?? 0) + normal.answerMs);
    expect(state.phaseStartedAt).toBe(now);
    expect(state.phaseEndsAt).toBe(question?.deadline);
    expect(computeScores(state.game)).toEqual(scoresBefore);
    // Öffentlicher Zustand gültig und ohne Antwort-Leak.
    const view = toPublicState(state);
    expect(publicLobbyStateSchema.safeParse(view).success).toBe(true);
    expect(findKeysDeep(view, PRE_REVEAL_FORBIDDEN_KEYS)).toEqual([]);

    adopt(sim, state, now);
    reconnectAll(sim);
    expect(sim.answer(host, sim.correct).ok).toBe(false); // vor startsAt → TOO_EARLY
    sim.toQuestionStart();
    expect(sim.answer(host, sim.correct).ok).toBe(true);
    expect(sim.answer(guest, sim.correct).ok).toBe(true);
    sim.playToEnd();
    expect(sim.state.phase).toBe("game_over");
    const ranking = sim.state.game?.results?.ranking ?? [];
    // 2 Züge × 3 Fragen: Host immer richtig (6), Gast nur Frage 1 falsch (5) – die Punkte vor dem Neustart zählen mit.
    expect(ranking.find((entry) => entry.playerId === sim.playerId(host))?.score).toBe(6);
    expect(ranking.find((entry) => entry.playerId === sim.playerId(guest))?.score).toBe(5);
  });

  it("startet die Kategoriewahl neu – eine Wahl, deren Fragen noch fehlten, verfällt", () => {
    const sim = lobbyWith(3, 0, { seed: "resume-pick", autoRespond: false });
    sim.ok({ type: "START", guestId: sim.host });
    sim.runUntil(() => sim.requests.length > 0);
    sim.respond(); // Kategorien
    expect(sim.state.phase).toBe("category_pick");
    const turn = currentTurn(sim.state.game);
    const picker = sim.guestOf(turn?.pickerId ?? "");
    sim.ok({ type: "PICK", guestId: picker, categoryId: turn?.options[1]?.id ?? "" });
    expect(sim.state.game?.pending?.kind).toBe("questions");

    const now = sim.now + 3_000;
    const { state, reset } = restore(sim.state, now);
    expect(reset).toBe("pick_discarded");
    expect(state.phase).toBe("category_pick");
    expect(state.game?.pending).toBeNull();
    expect(currentTurn(state.game)?.categoryId).toBeNull();
    expect(currentTurn(state.game)?.options).toEqual(turn?.options);
    expect(state.phaseEndsAt).toBe(now + GRACE + normal.categoryPickMs);
    expect(state.timers.some((timer) => timer.kind === "request")).toBe(false);

    // Die wählende Person wählt erneut; die Anfrage nach Fragen geht neu hinaus.
    const picked = reduce(
      reduce(state, { type: "RECONNECT", guestId: picker }, { now, rng: sim.rng }).state,
      { type: "PICK", guestId: picker, categoryId: turn?.options[2]?.id ?? "" },
      { now: now + 100, rng: sim.rng },
    );
    expect(picked.ok && picked.effects.some((effect) => effect.type === "loadQuestions")).toBe(true);
  });

  it("lässt bei einer aufgegebenen wählenden Person sofort den Zufall wählen", () => {
    const sim = lobbyWith(3, 0, { seed: "resume-resigned-picker" });
    sim.ok({ type: "START", guestId: sim.host });
    sim.runUntil((state) => state.phase === "category_pick");
    const pickerId = currentTurn(sim.state.game)?.pickerId ?? "";
    // Snapshot eines Zustands, in dem die wählende Person (z. B. per Reconnect-Frist) aufgegeben hat.
    const resigned: LobbyState = {
      ...sim.state,
      players: sim.state.players.map((player) =>
        player.playerId === pickerId ? { ...player, status: "resigned", left: true, connected: false } : player,
      ),
    };
    const now = sim.now + 1_000;
    const { state } = restore(resigned, now);
    expect(state.phaseEndsAt).toBe(now);
    const timer = state.timers.find((entry) => entry.kind === "phase");
    const fired = reduce(state, { type: "TIMEOUT", token: timer?.token ?? -1 }, { now, rng: sim.rng });
    expect(fired.ok && fired.effects.some((effect) => effect.type === "loadQuestions")).toBe(true);
  });

  it("wiederholt Zug-Ergebnis, Rundentafel und Intro und stellt eine offene Kategorie-Anfrage neu", () => {
    const sim = lobbyWith(2, 0, { seed: "resume-summary", autoRespond: false });
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 2, questionsPerCategory: 1 } });
    sim.ok({ type: "START", guestId: sim.host });
    const intro = restore(sim.state, sim.now + 500);
    expect(intro.state.phase).toBe("intro");
    expect(intro.state.phaseEndsAt).toBe(sim.now + 500 + normal.introMs);

    // Intro vorbei → Anfrage nach Kategorien offen (Phase bleibt intro).
    sim.runUntil(() => sim.requests.length > 0);
    expect(sim.state.phase).toBe("intro");
    expect(sim.state.game?.pending?.kind).toBe("options");
    const now = sim.now + 2_000;
    const { state, reset } = restore(sim.state, now);
    expect(reset).toBe("phase_restarted");
    expect(state.game?.pending).toBeNull();
    const timer = state.timers.find((entry) => entry.kind === "phase");
    expect(timer?.at).toBe(now + normal.introMs);
    const fired = reduce(
      state,
      { type: "TIMEOUT", token: timer?.token ?? -1 },
      { now: timer?.at ?? now, rng: sim.rng },
    );
    expect(fired.ok && fired.effects.filter((effect) => effect.type === "offerCategories")).toHaveLength(1);
    expect(fired.state.game?.pending?.kind).toBe("options");

    sim.respond();
    for (let i = 0; i < 40 && sim.state.phase !== "turn_summary"; i++) {
      if (sim.requests.length > 0) sim.respond();
      else sim.fireNext();
    }
    expect(sim.state.phase).toBe("turn_summary");
    const summary = restore(sim.state, sim.now + 100);
    expect(summary.state.phase).toBe("turn_summary");
    expect(summary.state.phaseEndsAt).toBe(sim.now + 100 + normal.turnSummaryMs);
  });

  it("„Host tippt Weiter“ (ADR-045): Auflösung und Zug-Ergebnis warten auch nach dem Neustart ohne Timer", () => {
    const sim = lobbyWith(2, 0, { seed: "resume-manual" });
    sim.ok({
      type: "UPDATE_SETTINGS",
      guestId: sim.host,
      update: { questionsPerCategory: 1, afterQuestionSec: 0, afterTurnSec: 0, afterRoundSec: 0 },
    });
    sim.ok({ type: "START", guestId: sim.host });
    sim.runUntil((state) => state.phase === "reveal");
    const reveal = restore(sim.state, sim.now + 1_000);
    expect(reveal.state.phase).toBe("reveal");
    expect(reveal.state.phaseEndsAt).toBeNull();
    expect(reveal.state.timers.some((timer) => timer.kind === "phase")).toBe(false);
    adopt(sim, reveal.state, sim.now + 1_000);
    reconnectAll(sim);
    sim.ok({ type: "CONTINUE", guestId: sim.host, phase: "reveal" });
    expect(sim.state.phase).toBe("turn_summary");
    const summary = restore(sim.state, sim.now + 500);
    expect(summary.state.phase).toBe("turn_summary");
    expect(summary.state.phaseEndsAt).toBeNull();
  });

  it("Anzeige-Modus und feste Kategorie überstehen die Wiederaufnahme (ADR-046/048)", () => {
    const sim = lobbyWith(3, 0, { seed: "resume-presenter" });
    const fixed = sim.catalog.categories[0]?.id ?? "";
    sim.ok({
      type: "UPDATE_SETTINGS",
      guestId: sim.host,
      update: { hostPlays: false, categoryIds: [fixed], questionsPerCategory: 2 },
    });
    sim.ok({ type: "START", guestId: sim.host });
    sim.runUntil((state) => state.phase === "reveal");
    const { state } = restore(sim.state, sim.now + 500);
    expect(state.settings).toMatchObject({ hostPlays: false, categoryIds: [fixed] });
    expect(state.players.find((player) => player.playerId === state.hostPlayerId)?.status).toBe("spectator");
    expect(state.game?.order).not.toContain(state.hostPlayerId);
    const turn = currentTurn(state.game);
    expect(turn?.options.map((option) => option.id)).toEqual([fixed]);
    expect(turn?.pickedBy).toBe("fixed");
  });

  it("lässt Spielende und Ergebnis unverändert (inkl. Beginn der Phase)", () => {
    const sim = lobbyWith(2, 1, { seed: "resume-over" });
    sim.ok({ type: "UPDATE_SETTINGS", guestId: sim.host, update: { rounds: 1, questionsPerCategory: 1 } });
    sim.ok({ type: "START", guestId: sim.host });
    sim.playToEnd();
    const left = sim.guests[1] ?? "";
    sim.ok({ type: "LEAVE", guestId: left });
    const now = sim.now + 60_000;
    const { state } = restore(sim.state, now);
    expect(state.phase).toBe("game_over");
    expect(state.game?.results).toEqual(sim.state.game?.results);
    expect(state.phaseStartedAt).toBe(sim.state.game?.endedAt);
    expect(state.players.find((player) => player.guestId === left)?.left).toBe(true);
    expect(state.timers.find((timer) => timer.kind === "idle_close")?.at).toBe(
      (sim.state.game?.endedAt ?? 0) + 2 * 60 * 60_000,
    );
  });
});

describe("fromLobbySnapshot – ungültige Snapshots", () => {
  const sim = lobbyWith(2, 0, { seed: "resume-invalid" });
  sim.ok({ type: "START", guestId: sim.host });
  sim.runUntil((state) => state.phase === "question");
  const doc = roundTrip(sim.state);
  const now = sim.now + 1_000;
  const rejectWith = (raw: unknown, reason: RegExp) => {
    const result = fromLobbySnapshot(raw, { now, timing: "normal" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  };

  it("lehnt Unsinn, geschlossene Lobbys und fremde Versionen ab, ohne zu werfen", () => {
    rejectWith(null, /Lobby-Dokument ungültig/);
    rejectWith("x", /Lobby-Dokument ungültig/);
    rejectWith({ ...doc, code: "abc" }, /Lobby-Dokument ungültig/);
    rejectWith({ ...doc, active: false }, /geschlossen/);
    rejectWith(
      { ...doc, game: { ...doc.game, snapshotVersion: GAME_SNAPSHOT_VERSION + 1 } },
      /Spiel-Snapshot ungültig/,
    );
    rejectWith({ ...doc, game: null }, /ohne Spiel-Snapshot/);
    expect(fromLobbySnapshot(doc, { now, timing: "langsam" as "normal" }).ok).toBe(false);
  });

  it("lehnt inkonsistente Spielstände ab (Mischung, Host, Phase)", () => {
    const game = structuredClone(doc.game) as { turns: Array<{ questions: Array<{ correct: number }> }> };
    const question = game.turns.at(-1)?.questions[0];
    if (question) question.correct = (question.correct + 1) % 4;
    rejectWith({ ...doc, game }, /Mischung/);
    rejectWith({ ...doc, hostPlayerId: "x".repeat(16) }, /Host/);
    rejectWith({ ...doc, phase: "reveal" }, /Auflösung ohne aufgelöste Frage/);
    rejectWith({ ...doc, phase: "game_over" }, /Spielende ohne Ergebnis/);
  });

  it("liest Version-1-Snapshots: aufgegeben = nicht mehr Mitglied", () => {
    const resigned = sim.state.players[1]?.playerId ?? "";
    const v1 = structuredClone(doc) as typeof doc & { game: Record<string, unknown> };
    v1.game.snapshotVersion = 1;
    delete v1.game.leftPlayerIds;
    delete v1.game.lastActivityAt;
    v1.players = v1.players.map((player) =>
      player.playerId === resigned ? { ...player, status: "resigned" as const } : player,
    );
    // Mit 2 Personen und einer aufgegebenen wäre das Spiel vorbei → nicht als laufend fortsetzbar.
    rejectWith(v1, /nicht fortsetzbar/);
    const three = lobbyWith(3, 0, { seed: "resume-v1" });
    three.ok({ type: "START", guestId: three.host });
    three.runUntil((state) => state.phase === "category_pick");
    const doc3 = roundTrip(three.state) as ReturnType<typeof roundTrip> & { game: Record<string, unknown> };
    doc3.game.snapshotVersion = 1;
    delete doc3.game.leftPlayerIds;
    const gone = doc3.players[2]?.playerId ?? "";
    doc3.players = doc3.players.map((player) =>
      player.playerId === gone ? { ...player, status: "resigned" as const } : player,
    );
    const result = fromLobbySnapshot(doc3, { now: three.now, timing: "normal" });
    expect(result.ok && result.state.players.find((player) => player.playerId === gone)?.left).toBe(true);
  });
});
