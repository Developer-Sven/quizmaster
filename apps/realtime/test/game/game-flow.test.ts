/**
 * Spielabläufe (docs/01 §Spielregeln, §Verbindung & Randfälle; docs/05 §Fairness): Reconnect während einer
 * Frage, Host-Übergabe nach der Trennungsfrist, Aufgeben (2 Personen → sofort Spielende, 3 Personen → weiter),
 * Beitritt in ein laufendes Spiel, Zufallskategorie bei Zeitablauf, Revanche und die Fehlercodes der
 * Spiel-Events (NOT_YOUR_TURN, INVALID_OPTION, TOO_EARLY, ALREADY_ANSWERED, TOO_LATE).
 */
import { currentQuestion, currentTurn } from "@quizmaster/game-engine";
import type { PublicLobbyState, SettingsUpdate } from "@quizmaster/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eventually, type TestClient, type TestServer } from "../helpers/index.ts";
import {
  actorOf,
  autoPlay,
  connectGuest,
  createLobby,
  joinLobby,
  lastSelf,
  lastState,
  runtimeOf,
  sleep,
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

async function lobbyWith(count: number, settings?: SettingsUpdate) {
  const clients: TestClient[] = [];
  const host = await connectGuest(server, { guestDoc: true });
  clients.push(host);
  const code = await createLobby(host, "Mia");
  const names = ["Ben", "Lea", "Tom", "Ida"];
  for (let index = 1; index < count; index++) {
    const client = await connectGuest(server, { guestDoc: true });
    await joinLobby(client, code, names[index - 1] ?? `Gast ${index}`);
    clients.push(client);
  }
  if (settings !== undefined) {
    const ack = await host.emit("lobby:update-settings", settings);
    if (!ack.ok) throw new Error(`Einstellungen abgelehnt: ${ack.error.code}`);
  }
  return { code, clients, host };
}

function playerById(state: PublicLobbyState | undefined, playerId: string) {
  return state?.players.find((player) => player.id === playerId);
}

describe("Verbindung", () => {
  it("Reconnect während einer Frage: gleicher Platz, Punkte bleiben, lobby:state + lobby:self nach resume", async () => {
    const { code, clients } = await lobbyWith(2, { rounds: 1, questionsPerCategory: 3 });
    const [host, guest] = clients as [TestClient, TestClient];
    const guestId = lastSelf(guest)?.playerId ?? "";
    const hostPlayer = autoPlay(server, host, code);
    const guestPlayer = autoPlay(server, guest, code);
    const secondQuestion = guest.waitFor(
      "lobby:state",
      (state) => state.phase === "question" && state.question?.index === 2,
      20_000,
    );
    expect((await host.emit("lobby:start", {})).ok).toBe(true);
    const during = await secondQuestion;
    guestPlayer.stop();
    const scoreBefore = playerById(during, guestId)?.score ?? 0;
    expect(scoreBefore).toBe(1);

    const offline = host.waitFor("lobby:state", (state) => playerById(state, guestId)?.connected === false);
    guest.close();
    await offline;

    const back = await connectGuest(server, { guestId: guest.guestId });
    const state = back.waitFor("lobby:state");
    const self = back.waitFor("lobby:self");
    expect(await back.emit("lobby:resume", { code })).toEqual({ ok: true, data: { code } });
    const [resumedState, resumedSelf] = await Promise.all([state, self]);
    expect(resumedSelf.playerId).toBe(guestId);
    expect(playerById(resumedState, guestId)).toMatchObject({ connected: true, status: "active" });
    expect(playerById(resumedState, guestId)?.score).toBeGreaterThanOrEqual(scoreBefore);
    const backPlayer = autoPlay(server, back, code);
    const final = await waitForPhase(host, "game_over", 30_000);
    hostPlayer.stop();
    backPlayer.stop();
    expect(final.results?.ranking.find((entry) => entry.playerId === guestId)?.status).toBe("active");
    expect(playerById(final, guestId)?.score).toBeGreaterThanOrEqual(scoreBefore);
    expect(back.contractViolations).toEqual([]);
    host.close();
    back.close();
  });

  it("Host getrennt → nach der Übergabefrist (fast: 2 s) wird die am längsten anwesende verbundene Person Host", async () => {
    const { code, clients } = await lobbyWith(3, { rounds: 2, questionsPerCategory: 3 });
    const [host, ben, lea] = clients as [TestClient, TestClient, TestClient];
    const hostId = lastSelf(host)?.playerId ?? "";
    const benId = lastSelf(ben)?.playerId ?? "";
    const players = [autoPlay(server, ben, code), autoPlay(server, lea, code)];
    const intro = ben.waitFor("lobby:state", (state) => state.phase === "intro");
    expect((await host.emit("lobby:start", {})).ok).toBe(true);
    await intro;
    const hostGone = ben.waitFor("lobby:state", (state) => playerById(state, hostId)?.connected === false);
    const handedOver = ben.waitFor("lobby:self", (self) => self.isHost, 10_000);
    const notice = ben.waitFor("notice", (payload) => payload.code === "HOST_CHANGED", 10_000);
    const disconnectedAt = Date.now();
    host.close();
    await hostGone;
    await handedOver;
    await notice;
    expect(Date.now() - disconnectedAt).toBeGreaterThanOrEqual(1_900);
    const state = lastState(ben);
    expect(playerById(state, benId)?.isHost).toBe(true);
    // Der alte Host ist noch Mitglied (Reconnect-Frist im Spiel 5 s), nur nicht mehr Host.
    expect(playerById(state, hostId)).toMatchObject({ isHost: false, status: "active", connected: false });
    for (const player of players) player.stop();
    ben.close();
    lea.close();
  });
});

describe("Aufgeben und Beitritt", () => {
  it("2 Personen: Aufgeben im Spiel beendet es sofort (Aufgegeben hinter allen Aktiven, games-Dokument)", async () => {
    const { code, clients } = await lobbyWith(2, { rounds: 3, questionsPerCategory: 3 });
    const [host, guest] = clients as [TestClient, TestClient];
    const guestId = lastSelf(guest)?.playerId ?? "";
    const hostId = lastSelf(host)?.playerId ?? "";
    const question = host.waitFor("lobby:state", (state) => state.phase === "question", 20_000);
    const hostPlayer = autoPlay(server, host, code, { answer: "wrong" });
    expect((await host.emit("lobby:start", {})).ok).toBe(true);
    await question;
    const notice = host.waitFor("notice", (payload) => payload.code === "PLAYER_LEFT");
    const over = waitForPhase(host, "game_over");
    expect(await guest.emit("lobby:leave", {})).toEqual({ ok: true, data: null });
    const final = await over;
    await notice;
    hostPlayer.stop();
    expect(final.results?.ranking).toEqual([
      { playerId: hostId, place: 1, score: 0, status: "active" },
      { playerId: guestId, place: 2, score: 0, status: "resigned" },
    ]);
    expect(final.results?.outcome).toBe("win");
    expect(playerById(final, guestId)?.status).toBe("resigned");
    const [game] = await waitForGameDoc(server, actorOf(server, code).lobbyId);
    expect(game?.players.find((player) => player.guestId === guest.guestId)?.status).toBe("resigned");
    // Wer aufgegeben hat, kommt nicht zurück.
    expect(await guest.emit("lobby:resume", { code })).toMatchObject({ ok: false, error: { code: "RESIGNED" } });
    host.close();
    guest.close();
  });

  it("3 Personen: nach dem Aufgeben läuft das Spiel für die anderen weiter; Beitritt ins laufende Spiel → GAME_IN_PROGRESS", async () => {
    const { code, clients } = await lobbyWith(3, { rounds: 1, questionsPerCategory: 2 });
    const [host, ben, lea] = clients as [TestClient, TestClient, TestClient];
    const leaId = lastSelf(lea)?.playerId ?? "";
    const players = [autoPlay(server, host, code), autoPlay(server, ben, code)];
    const question = host.waitFor("lobby:state", (state) => state.phase === "question", 20_000);
    expect((await host.emit("lobby:start", {})).ok).toBe(true);
    await question;

    const late = await connectGuest(server);
    expect(await late.emit("lobby:join", { code, name: "Ida" })).toMatchObject({
      ok: false,
      error: { code: "GAME_IN_PROGRESS" },
    });
    expect(await lea.emit("lobby:leave", {})).toEqual({ ok: true, data: null });
    await eventually(() => playerById(lastState(host), leaId)?.status === "resigned");
    expect(lastState(host)?.phase).not.toBe("game_over");
    const final = await waitForPhase(host, "game_over", 30_000);
    for (const player of players) player.stop();
    // Aufgegeben = hinter allen Aktiven; ihr Zug entfällt, außer er lief beim Aufgeben schon (sie wählte zuerst).
    expect(final.results?.ranking.at(-1)).toMatchObject({ playerId: leaId, status: "resigned" });
    const leaTurns = final.board.filter((row) => row.pickerId === leaId).length;
    expect(leaTurns).toBe(final.order?.indexOf(leaId) === 0 ? 1 : 0);
    expect(final.board).toHaveLength(2 + leaTurns);
    for (const client of [host, ben, lea, late]) client.close();
  });
});

describe("Spielregeln", () => {
  it("Kategoriewahl-Zeit abgelaufen → Zufall aus den drei Optionen (pickedBy timeout)", async () => {
    const { code, clients } = await lobbyWith(2, { rounds: 1, questionsPerCategory: 1 });
    const [host, guest] = clients as [TestClient, TestClient];
    const players = [autoPlay(server, host, code, { pick: false }), autoPlay(server, guest, code, { pick: false })];
    const picks: PublicLobbyState[] = [];
    host.socket.on("lobby:state", (state) => {
      // Ein Eintrag je Kategoriewahl (weitere Zustände derselben Phase ignorieren).
      if (state.phase === "category_pick" && picks.at(-1)?.phaseStartedAt !== state.phaseStartedAt) picks.push(state);
    });
    const over = waitForPhase(host, "game_over", 30_000);
    expect((await host.emit("lobby:start", {})).ok).toBe(true);
    const final = await over;
    for (const player of players) player.stop();
    expect(final.board).toHaveLength(2);
    const offered = picks.map((state) => state.turn?.options.map((option) => option.id) ?? []);
    final.board.forEach((row, index) => {
      expect(offered[index]).toContain(row.categoryId);
    });
    // Die Wahl kommt erst nach Ablauf der 1,5 s (fast) – niemand hat gewählt.
    for (const state of picks) expect((state.phaseEndsAt ?? 0) - state.phaseStartedAt).toBe(1_500);
    const [game] = await waitForGameDoc(server, actorOf(server, code).lobbyId);
    expect(game?.turns.map((turn) => turn.pickedBy)).toEqual(["timeout", "timeout"]);
    host.close();
    guest.close();
  });

  it("Fehlercodes: NOT_YOUR_TURN, INVALID_OPTION, TOO_EARLY, ALREADY_ANSWERED, TOO_LATE, INVALID_PHASE", async () => {
    const { clients } = await lobbyWith(2, { rounds: 1, questionsPerCategory: 2 });
    const [host, guest] = clients as [TestClient, TestClient];
    expect(await host.emit("game:answer", { questionId: "q1", choice: 0 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE" },
    });
    const pickPhase = host.waitFor("lobby:state", (state) => state.phase === "category_pick");
    expect((await host.emit("lobby:start", {})).ok).toBe(true);
    const pick = await pickPhase;
    const pickerId = pick.turn?.pickerId ?? "";
    const picker = lastSelf(host)?.playerId === pickerId ? host : guest;
    const waiting = picker === host ? guest : host;
    expect(await waiting.emit("game:pick", { categoryId: pick.turn?.options[0]?.id ?? "" })).toMatchObject({
      ok: false,
      error: { code: "NOT_YOUR_TURN" },
    });
    const offeredIds = new Set(pick.turn?.options.map((option) => option.id));
    const notOffered = ["comics", "kinofilme", "tv-serien", "im-labor"].find((id) => !offeredIds.has(id)) ?? "comics";
    expect(await picker.emit("game:pick", { categoryId: notOffered })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OPTION" },
    });
    const questionState = picker.waitFor("lobby:state", (state) => state.phase === "question");
    expect(await picker.emit("game:pick", { categoryId: pick.turn?.options[1]?.id ?? "" })).toEqual({
      ok: true,
      data: null,
    });
    expect(await picker.emit("game:pick", { categoryId: pick.turn?.options[1]?.id ?? "" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE" },
    });
    const question = (await questionState).question;
    if (question === null) throw new Error("Frage fehlt");
    // Vorlauf (fast: 150 ms): vor startsAt → TOO_EARLY. Nur prüfbar, solange der Vorlauf nicht schon um ist.
    if (question.startsAt - Date.now() > 60) {
      expect(await host.emit("game:answer", { questionId: question.id, choice: 1 })).toMatchObject({
        ok: false,
        error: { code: "TOO_EARLY" },
      });
    }
    await sleep(Math.max(0, question.startsAt - Date.now()) + 20);
    const ack = await host.emit("game:answer", { questionId: question.id, choice: 2 });
    // Invariante 3: exakt { accepted: true } – kein richtig/falsch, keine weiteren Felder.
    expect(ack).toEqual({ ok: true, data: { accepted: true } });
    expect(await host.emit("game:answer", { questionId: question.id, choice: 3 })).toMatchObject({
      ok: false,
      error: { code: "ALREADY_ANSWERED" },
    });
    expect(await host.emit("game:answer", { questionId: "unbekannt", choice: 3 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OPTION" },
    });
    const self = lastSelf(host);
    expect(self?.myAnswer).toEqual({ questionId: question.id, choice: 2 });
    // Nach der Auflösung: dieselbe Frage → TOO_LATE.
    await waitForPhase(host, "reveal", 10_000);
    expect(await guest.emit("game:answer", { questionId: question.id, choice: 0 })).toMatchObject({
      ok: false,
      error: { code: "TOO_LATE" },
    });
    host.close();
    guest.close();
  });
});

describe("Weiter per Host (ADR-045)", () => {
  it("wartet ohne Timer auf den Host; Gast → NOT_HOST, falsche Phase → INVALID_PHASE, Doppeltipp schadet nicht", async () => {
    const { code, clients, host } = await lobbyWith(2, {
      rounds: 1,
      questionsPerCategory: 1,
      afterQuestionSec: 0,
      afterTurnSec: 0,
      afterRoundSec: 0,
    });
    const guest = clients[1] as TestClient;
    const players = clients.map((client) => autoPlay(server, client, code, { answer: "correct" }));
    const reveal = host.waitFor("lobby:state", (state) => state.phase === "reveal", 30_000);
    expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    expect((await reveal).phaseEndsAt).toBeNull();
    // Ohne „Weiter“ bleibt die Auflösung stehen (schneller Modus: sonst nach 300 ms vorbei).
    await sleep(1_000);
    expect(lastState(host)?.phase).toBe("reveal");
    expect(await guest.emit("game:continue", { phase: "reveal" })).toMatchObject({
      ok: false,
      error: { code: "NOT_HOST" },
    });
    expect(await host.emit("game:continue", { phase: "round_board" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE" },
    });
    const summary = host.waitFor("lobby:state", (state) => state.phase === "turn_summary", 10_000);
    const [first, second] = await Promise.all([
      host.emit("game:continue", { phase: "reveal" }),
      host.emit("game:continue", { phase: "reveal" }),
    ]);
    expect(first).toEqual({ ok: true, data: null });
    expect(second).toMatchObject({ ok: false, error: { code: "INVALID_PHASE" } });
    expect((await summary).phaseEndsAt).toBeNull();
    for (const player of players) player.stop();
    for (const client of clients) client.close();
  });

  it("automatische Phasen: game:continue → INVALID_PHASE; die Phase endet nach der festen Dauer", async () => {
    const { code, clients, host } = await lobbyWith(2, { rounds: 1, questionsPerCategory: 1 });
    const players = clients.map((client) => autoPlay(server, client, code, { answer: "correct" }));
    const reveal = host.waitFor("lobby:state", (state) => state.phase === "reveal", 30_000);
    expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    const state = await reveal;
    expect(state.phaseEndsAt).not.toBeNull();
    expect(await host.emit("game:continue", { phase: "reveal" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE" },
    });
    await waitForPhase(host, "game_over", 30_000);
    for (const player of players) player.stop();
    for (const client of clients) client.close();
  });
});

describe("Zeit pro Frage: Host löst auf (ADR-049)", () => {
  it("ohne Countdown wartet die Frage; erst ab Fragebeginn löst der Host auf, nicht der Gast", async () => {
    const { clients, host } = await lobbyWith(2, { rounds: 1, questionsPerCategory: 1, answerSec: 0 });
    const guest = clients[1] as TestClient;
    const pick = host.waitFor("lobby:state", (state) => state.phase === "category_pick", 30_000);
    expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    const picking = await pick;
    const picker = picking.turn?.pickerId === lastSelf(host)?.playerId ? host : guest;
    const question = host.waitFor("lobby:state", (state) => state.phase === "question", 30_000);
    expect(await picker.emit("game:pick", { categoryId: picking.turn?.options[0]?.id ?? "" })).toEqual({
      ok: true,
      data: null,
    });
    const asked = await question;
    expect(await host.emit("game:continue", { phase: "question" })).toMatchObject({
      ok: false,
      error: { code: "TOO_EARLY" },
    });
    await sleep(Math.max(0, (asked.question?.startsAt ?? 0) - Date.now()) + 1_000);
    expect(lastState(host)?.phase).toBe("question");
    expect(await guest.emit("game:continue", { phase: "question" })).toMatchObject({
      ok: false,
      error: { code: "NOT_HOST" },
    });
    const reveal = host.waitFor("lobby:state", (state) => state.phase === "reveal", 10_000);
    expect(await host.emit("game:continue", { phase: "question" })).toEqual({ ok: true, data: null });
    expect((await reveal).question?.correct).toBeDefined();
    for (const client of clients) client.close();
  });
});

describe("Anzeige-Modus und feste Kategorie (ADR-046/048)", () => {
  it("Host zeigt nur an: spielt nicht mit, Antworten → INVALID_PHASE, nicht im Ergebnis", async () => {
    const { code, clients, host } = await lobbyWith(3, { rounds: 1, questionsPerCategory: 1, hostPlays: false });
    const players = clients.slice(1).map((client) => autoPlay(server, client, code, { answer: "correct" }));
    const question = host.waitFor("lobby:state", (state) => state.phase === "question", 30_000);
    expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    const state = await question;
    const hostId = lastSelf(host)?.playerId ?? "";
    expect(state.players.find((player) => player.id === hostId)?.status).toBe("spectator");
    expect(state.order).not.toContain(hostId);
    await sleep(Math.max(0, (state.question?.startsAt ?? 0) - Date.now()) + 20);
    expect(await host.emit("game:answer", { questionId: state.question?.id ?? "", choice: 0 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PHASE" },
    });
    const over = await waitForPhase(host, "game_over", 60_000);
    expect(over.results?.ranking.map((entry) => entry.playerId)).not.toContain(hostId);
    for (const player of players) player.stop();
    for (const client of clients) client.close();
  });

  it("eine feste Kategorie: kein Wahl-Schritt, jeder Zug in dieser Kategorie", async () => {
    const fixed = runtimeOf(server).questions.playableCategories()[0]?.id ?? "";
    const { code, clients, host } = await lobbyWith(2, { rounds: 1, questionsPerCategory: 1, categoryIds: [fixed] });
    const phases: string[] = [];
    host.socket.on("lobby:state", (state: PublicLobbyState) => phases.push(state.phase));
    const players = clients.map((client) => autoPlay(server, client, code, { answer: "correct" }));
    expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    await waitForPhase(host, "game_over", 60_000);
    expect(phases).not.toContain("category_pick");
    const actor = actorOf(server, code);
    const turns = actor.state.game?.turns ?? actor.state.lastGame?.turns ?? [];
    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) expect(turn.categoryId).toBe(fixed);
    for (const player of players) player.stop();
    for (const client of clients) client.close();
  });
});

describe("Host beendet das Spiel (ADR-051)", () => {
  it("game:end: alle sehen das Ergebnis mit Hinweis, danach geht es zurück in die Lobby", async () => {
    const { code, clients, host } = await lobbyWith(2, { rounds: 3, questionsPerCategory: 3 });
    const guest = clients[1] as TestClient;
    const players = clients.map((client) => autoPlay(server, client, code, { answer: "correct" }));
    const question = host.waitFor("lobby:state", (state) => state.phase === "question", 30_000);
    expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    await question;
    expect(await guest.emit("game:end", {})).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });
    const notice = guest.waitFor("notice", (entry) => entry.code === "GAME_ENDED", 10_000);
    const over = guest.waitFor("lobby:state", (state) => state.phase === "game_over", 10_000);
    expect(await host.emit("game:end", {})).toEqual({ ok: true, data: null });
    await notice;
    expect((await over).results?.ranking).toHaveLength(2);
    await waitForPhase(guest, "lobby", 15_000);
    expect(await host.emit("game:end", {})).toMatchObject({ ok: false, error: { code: "INVALID_PHASE" } });
    for (const player of players) player.stop();
    for (const client of clients) client.close();
  });
});

describe("Revanche", () => {
  it("setzt Punkte und Tafel zurück, behält die Einstellungen, lost neu aus und speichert ein zweites Spiel", async () => {
    const { code, clients } = await lobbyWith(2, { rounds: 1, questionsPerCategory: 1 });
    const [host, guest] = clients as [TestClient, TestClient];
    const players = [autoPlay(server, host, code), autoPlay(server, guest, code, { answer: "wrong" })];
    const firstOver = waitForPhase(host, "game_over", 30_000);
    expect((await host.emit("lobby:start", {})).ok).toBe(true);
    const first = await firstOver;
    expect(first.players.some((player) => player.score > 0)).toBe(true);
    const actor = actorOf(server, code);
    const firstGameId = actor.state.game?.gameId;
    await waitForGameDoc(server, actor.lobbyId, 1);

    expect(await guest.emit("game:rematch", {})).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });
    const intro = host.waitFor("lobby:state", (state) => state.phase === "intro");
    expect(await host.emit("game:rematch", {})).toEqual({ ok: true, data: null });
    const restarted = await intro;
    expect(restarted.players.map((player) => player.score)).toEqual([0, 0]);
    expect(restarted.board).toEqual([]);
    expect(restarted.results).toBeNull();
    expect(restarted.settings).toEqual(first.settings);
    expect([...(restarted.order ?? [])].sort()).toEqual([...(first.order ?? [])].sort());
    expect(restarted.rev).toBeGreaterThan(first.rev);
    expect(actor.state.game?.gameId).not.toBe(firstGameId);

    const second = await host.waitFor("lobby:state", (state) => state.phase === "game_over", 30_000);
    for (const player of players) player.stop();
    expect(second.board).toHaveLength(2);
    const games = await waitForGameDoc(server, actor.lobbyId, 2);
    expect(new Set(games.map((game) => game._id)).size).toBe(2);
    // Keine Frage wiederholt sich über die Revanche hinweg (gesehene Fragen der Lobby + recentQuestionIds).
    const played = games.flatMap((game) => game.turns.flatMap((turn) => turn.questions.map((q) => q.questionId)));
    expect(new Set(played).size).toBe(played.length);
    const hostDoc = await server.db.collections.guests.findOne({ _id: host.guestId });
    expect(hostDoc?.stats.games).toBe(2);
    host.close();
    guest.close();
  });
});

describe("Server-Zustand (Kontrolle)", () => {
  it("die richtige Antwort steht nur im Server-Zustand, nie im öffentlichen Zustand vor reveal", async () => {
    const { code, clients } = await lobbyWith(2, { rounds: 1, questionsPerCategory: 1 });
    const [host, guest] = clients as [TestClient, TestClient];
    const players = [
      autoPlay(server, host, code, { answer: "none" }),
      autoPlay(server, guest, code, { answer: "none" }),
    ];
    const questionPhase = host.waitFor("lobby:state", (state) => state.phase === "question", 20_000);
    expect((await host.emit("lobby:start", {})).ok).toBe(true);
    const state = await questionPhase;
    const internal = actorOf(server, code).state;
    expect(currentQuestion(internal.game)?.correct).toBeTypeOf("number");
    expect(currentTurn(internal.game)?.categoryId).toBe(state.question?.categoryId);
    expect(state.question?.correct).toBeUndefined();
    expect(state.question?.picks).toBeUndefined();
    expect(state.question?.explanation).toBeUndefined();
    for (const player of players) player.stop();
    host.close();
    guest.close();
  });
});
