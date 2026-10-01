/**
 * Komplette Spiele über den echten Transport (docs/11 §Integration): 2 und 3 Personen bis `game_over` inkl.
 * Punkte, Rangliste, Tafel, games-Dokument, Gast- und Fragen-Statistik in der Test-DB. Dazu die
 * Sicherheits-Invarianten end-to-end über ALLE empfangenen Server→Client-Payloads (docs/06 Invarianten 1, 3, 4)
 * und „rev steigt monoton“.
 */
import {
  type AnswerIndex,
  CLIENT_FORBIDDEN_KEYS,
  DEFAULT_LOBBY_SETTINGS,
  findKeysDeep,
  PRE_REVEAL_FORBIDDEN_KEYS,
  type PublicLobbyState,
} from "@quizmaster/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestClient, TestServer } from "../helpers/index.ts";
import {
  actorOf,
  autoPlay,
  connectGuest,
  createLobby,
  joinLobby,
  lastSelf,
  receivedStates,
  startGameServer,
  waitForGameDoc,
  waitForPhase,
} from "./support.ts";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startGameServer();
});
afterAll(() => server?.cleanup());

/** Invariante 1 + 4 über alle Payloads eines Clients; dazu „Punkte/Tafel nur aus aufgelösten Fragen“ und rev. */
function expectCleanPayloads(client: TestClient) {
  expect(client.contractViolations).toEqual([]);
  for (const entry of client.received) {
    expect(findKeysDeep(entry.payload, CLIENT_FORBIDDEN_KEYS), entry.event).toEqual([]);
    expect(findKeysDeep(entry.payload, ["source", "stats", "shownOrder", "responses"]), entry.event).toEqual([]);
    if (entry.event === "lobby:self") {
      expect(findKeysDeep(entry.payload, PRE_REVEAL_FORBIDDEN_KEYS)).toEqual([]);
    }
    if (entry.event !== "lobby:state") continue;
    const state = entry.payload as PublicLobbyState;
    if (state.phase !== "reveal") {
      expect(findKeysDeep(state, PRE_REVEAL_FORBIDDEN_KEYS), `Phase ${state.phase}`).toEqual([]);
    }
    const trues = state.board.reduce(
      (sum, row) => sum + Object.values(row.results).reduce((acc, list) => acc + list.filter(Boolean).length, 0),
      0,
    );
    expect(state.players.reduce((sum, player) => sum + player.score, 0)).toBe(trues);
    if (state.phase === "question" && state.question !== null && state.turn !== null && state.progress !== null) {
      const round = state.progress.round;
      const pickerId = state.turn.pickerId;
      const row = state.board.filter((entry) => entry.round === round && entry.pickerId === pickerId).at(-1);
      const resolved = row === undefined ? 0 : Math.max(0, ...Object.values(row.results).map((list) => list.length));
      // Laufende Frage ist nie auf der Tafel: nur die bereits aufgelösten Fragen dieses Zuges.
      expect(resolved).toBe(state.question.index - 1);
    }
  }
  const revs = receivedStates(client).map((state) => state.rev);
  for (let index = 1; index < revs.length; index++) {
    expect(revs[index] ?? 0).toBeGreaterThanOrEqual(revs[index - 1] ?? 0);
  }
  expect((revs.at(-1) ?? 0) > (revs[0] ?? 0)).toBe(true);
}

describe("Spiel mit 2 Personen", () => {
  it("läuft bis game_over: Punkte, Rangliste, Tafel, games-Dokument und Statistik stimmen", async () => {
    const host = await connectGuest(server, { guestDoc: true });
    const guest = await connectGuest(server, { guestDoc: true });
    const code = await createLobby(host, "Mia");
    await joinLobby(guest, code, "Ben");
    const settings = await host.emit("lobby:update-settings", { rounds: 2, questionsPerCategory: 2 });
    expect(settings).toEqual({ ok: true, data: null });

    const hostPlayer = autoPlay(server, host, code, { answer: "correct" });
    const guestPlayer = autoPlay(server, guest, code, { answer: "wrong" });
    const over = waitForPhase(host, "game_over", 60_000);
    expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    const final = await over;
    hostPlayer.stop();
    guestPlayer.stop();

    const hostId = lastSelf(host)?.playerId ?? "";
    const guestId = lastSelf(guest)?.playerId ?? "";
    expect(final.results?.outcome).toBe("win");
    expect(final.results?.ranking).toEqual([
      { playerId: hostId, place: 1, score: 8, status: "active" },
      { playerId: guestId, place: 2, score: 0, status: "active" },
    ]);
    expect(final.players.find((player) => player.id === hostId)?.score).toBe(8);
    // Jede Person wählt genau einmal pro Runde (Reihenfolge ausgelost, in beiden Runden gleich).
    expect(final.board).toHaveLength(4);
    for (const round of [1, 2]) {
      const pickers = final.board.filter((row) => row.round === round).map((row) => row.pickerId);
      expect([...pickers].sort()).toEqual([hostId, guestId].sort());
    }
    expect(final.board.filter((row) => row.round === 1).map((row) => row.pickerId)).toEqual(final.order?.slice(0, 2));
    for (const row of final.board) {
      expect(row.results[hostId]).toEqual([true, true]);
      expect(row.results[guestId]).toEqual([false, false]);
    }
    expect(hostPlayer.rejected).toEqual([]);
    expect(guestPlayer.rejected).toEqual([]);
    expect(hostPlayer.answers + guestPlayer.answers).toBe(16);
    // Invariante 3: das Ack verrät nie richtig/falsch.
    for (const ack of [...hostPlayer.answerAcks, ...guestPlayer.answerAcks]) {
      expect(ack).toEqual({ ok: true, data: { accepted: true } });
    }

    const actor = actorOf(server, code);
    const [game] = await waitForGameDoc(server, actor.lobbyId);
    expect(game?.outcome).toBe("win");
    expect(game?.code).toBe(code);
    expect(game?.settings).toEqual({ ...DEFAULT_LOBBY_SETTINGS, rounds: 2, questionsPerCategory: 2 });
    expect(game?.players.map((player) => [player.guestId, player.place, player.score, player.isBot])).toEqual([
      [host.guestId, 1, 8, false],
      [guest.guestId, 2, 0, false],
    ]);
    expect(game?.turns).toHaveLength(4);
    const playedIds = (game?.turns ?? []).flatMap((turn) => turn.questions.map((question) => question.questionId));
    expect(new Set(playedIds).size).toBe(8);
    for (const turn of game?.turns ?? []) {
      expect(turn.pickedBy).toBe("player");
      expect(turn.offered).toContain(turn.categoryId);
      for (const question of turn.questions) {
        expect(question.answers.map((answer) => [answer.playerId, answer.correct])).toEqual(
          expect.arrayContaining([
            [hostId, true],
            [guestId, false],
          ]),
        );
      }
    }

    const hostDoc = await server.db.collections.guests.findOne({ _id: host.guestId });
    const guestDoc = await server.db.collections.guests.findOne({ _id: guest.guestId });
    expect(hostDoc?.stats).toEqual({ games: 1, wins: 1, draws: 0, answers: 8, correct: 8 });
    expect(guestDoc?.stats).toEqual({ games: 1, wins: 0, draws: 0, answers: 8, correct: 0 });
    expect(hostDoc?.recentQuestionIds).toEqual(playedIds);
    expect(guestDoc?.recentQuestionIds).toEqual(playedIds);
    const questions = await server.db.collections.questions.find({ _id: { $in: playedIds } }).toArray();
    expect(questions).toHaveLength(8);
    for (const question of questions) expect(question.stats).toMatchObject({ shown: 2, correct: 1 });

    expectCleanPayloads(host);
    expectCleanPayloads(guest);
    host.close();
    guest.close();
  });
});

describe("Spiel mit 3 Personen", () => {
  it("Gleichstand = gleicher Platz, keine Antwort = null auf der Tafel, frühe Auflösung", async () => {
    const [a, b, c] = await Promise.all([
      connectGuest(server, { guestDoc: true }),
      connectGuest(server, { guestDoc: true }),
      connectGuest(server, { guestDoc: true }),
    ]);
    if (a === undefined || b === undefined || c === undefined) throw new Error("Clients fehlen");
    const code = await createLobby(a, "Anna");
    await joinLobby(b, code, "Bert");
    await joinLobby(c, code, "Anna");
    // Namenskollision → eindeutiger Name.
    const lobby = await waitForPhase(a, "lobby");
    expect(lobby.players.map((player) => player.name)).toContain("Anna");
    await a.emit("lobby:update-settings", { rounds: 1, questionsPerCategory: 2 });

    const players = [
      autoPlay(server, a, code, { answer: "correct" }),
      autoPlay(server, b, code, { answer: "wrong" }),
      // Erste Frage jedes Zuges unbeantwortet (Zeit läuft ab), zweite falsch → frühe Auflösung.
      autoPlay(server, c, code, {
        answer: (question, correct) => (question.index === 1 ? null : (((correct + 2) % 4) as AnswerIndex)),
      }),
    ];
    const reveals: PublicLobbyState[] = [];
    a.socket.on("lobby:state", (state) => {
      if (state.phase === "reveal") reveals.push(state);
    });
    const over = waitForPhase(a, "game_over", 60_000);
    expect(await a.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    const final = await over;
    for (const player of players) player.stop();

    const idA = lastSelf(a)?.playerId ?? "";
    const idB = lastSelf(b)?.playerId ?? "";
    const idC = lastSelf(c)?.playerId ?? "";
    const names = final.players.map((player) => player.name);
    expect(new Set(names).size).toBe(3);
    expect(names).toContain("Anna 2");
    expect(final.results?.ranking).toEqual([
      { playerId: idA, place: 1, score: 6, status: "active" },
      ...[idB, idC]
        .sort((x, y) => (final.order?.indexOf(x) ?? 0) - (final.order?.indexOf(y) ?? 0))
        .map((playerId) => ({ playerId, place: 2, score: 0, status: "active" })),
    ]);
    expect(final.board).toHaveLength(3);
    // Jede Person wählt genau einmal (eine Runde) in der ausgelosten Reihenfolge.
    expect(final.board.map((row) => row.pickerId)).toEqual(final.order);
    for (const row of final.board) {
      expect(row.results[idC]).toEqual([null, false]);
      expect(row.results[idB]).toEqual([false, false]);
    }
    // Frühe Auflösung: bei der zweiten Frage jedes Zuges antworten alle → Auflösung lange vor der Deadline.
    const early = reveals.filter((state) => state.question?.index === 2);
    expect(early.length).toBeGreaterThan(0);
    for (const state of early) {
      expect(state.phaseStartedAt).toBeLessThan((state.question?.deadline ?? 0) - 500);
      expect(state.question?.correct).toBeTypeOf("number");
      expect(state.question?.picks?.[idC]).not.toBeNull();
    }
    // Erste Frage: C ohne Antwort → Auflösung erst nach der Deadline, picks[C] = null.
    const late = reveals.filter((state) => state.question?.index === 1);
    for (const state of late) {
      expect(state.phaseStartedAt).toBeGreaterThanOrEqual(state.question?.deadline ?? 0);
      expect(state.question?.picks?.[idC]).toBeNull();
    }

    const actor = actorOf(server, code);
    const [game] = await waitForGameDoc(server, actor.lobbyId);
    expect(game?.players.map((player) => [player.playerId, player.place])).toEqual(
      final.results?.ranking.map((entry) => [entry.playerId, entry.place]),
    );
    const cDoc = await server.db.collections.guests.findOne({ _id: c.guestId });
    expect(cDoc?.stats).toEqual({ games: 1, wins: 0, draws: 0, answers: 6, correct: 0 });
    for (const client of [a, b, c]) {
      expectCleanPayloads(client);
      client.close();
    }
  });
});
