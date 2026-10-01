/**
 * Dev-Bots (docs/05 §Dev-Bots, E2E-Szenario 8 serverseitig): Host fügt Bots hinzu (höchstens 7, nur der
 * Host, nur vor Spielbeginn), Host + 3 Bots spielen bis zum Ende. Bots zählen im Ergebnis, aber nicht in der
 * Gast- und Fragen-Statistik.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestServer } from "../helpers/index.ts";
import {
  actorOf,
  autoPlay,
  connectGuest,
  createLobby,
  joinLobby,
  startGameServer,
  waitForGameDoc,
  waitForPhase,
} from "./support.ts";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startGameServer({ devBots: true });
});
afterAll(() => server?.cleanup());

describe("Dev-Bots", () => {
  it("Host + 3 Bots spielen bis zum Ende; Statistik nur für den Menschen", async () => {
    const host = await connectGuest(server, { guestDoc: true });
    const code = await createLobby(host, "Mia");
    for (let index = 0; index < 3; index++) {
      expect(await host.emit("dev:add-bot", {})).toEqual({ ok: true, data: null });
    }
    const updated = host.waitFor("lobby:state", (state) => state.settings.questionsPerCategory === 2);
    expect(await host.emit("lobby:update-settings", { rounds: 1, questionsPerCategory: 2 })).toEqual({
      ok: true,
      data: null,
    });
    const lobby = await updated;
    const bots = lobby.players.filter((player) => player.isBot);
    expect(bots.map((bot) => bot.name)).toEqual(["Bot 1", "Bot 2", "Bot 3"]);
    expect(bots.every((bot) => bot.connected && !bot.isHost)).toBe(true);

    const hostPlayer = autoPlay(server, host, code);
    const over = waitForPhase(host, "game_over", 60_000);
    expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    const final = await over;
    hostPlayer.stop();

    expect(final.board).toHaveLength(4);
    expect(new Set(final.board.map((row) => row.pickerId)).size).toBe(4);
    for (const bot of bots) {
      // Bots wählen selbst und antworten (irgendwann innerhalb der Antwortzeit).
      const answered = final.board.flatMap((row) => row.results[bot.id] ?? []).filter((result) => result !== null);
      expect(answered.length).toBeGreaterThan(0);
    }
    expect(final.results?.ranking).toHaveLength(4);

    const [game] = await waitForGameDoc(server, actorOf(server, code).lobbyId);
    expect(game?.players.filter((player) => player.isBot)).toHaveLength(3);
    expect(game?.players.filter((player) => player.isBot).every((player) => player.guestId.startsWith("bot:"))).toBe(
      true,
    );
    const hostDoc = await server.db.collections.guests.findOne({ _id: host.guestId });
    // 4 Personen × 1 Runde × 2 Fragen = 8 Fragen, alle richtig beantwortet.
    expect(hostDoc?.stats).toMatchObject({ games: 1, answers: 8, correct: 8 });
    const playedIds = (game?.turns ?? []).flatMap((turn) => turn.questions.map((question) => question.questionId));
    const questions = await server.db.collections.questions.find({ _id: { $in: playedIds } }).toArray();
    // Nur der Mensch zählt in der Fragen-Statistik.
    for (const question of questions) expect(question.stats).toMatchObject({ shown: 1, correct: 1 });
    expect(await server.db.collections.guests.countDocuments({ _id: /^bot:/ })).toBe(0);
    host.close();
  });

  it("höchstens 7 Bots, nur der Host, nur vor Spielbeginn", async () => {
    const host = await connectGuest(server);
    const code = await createLobby(host, "Mia");
    const guest = await connectGuest(server);
    await joinLobby(guest, code, "Ben");
    expect(await guest.emit("dev:add-bot", {})).toMatchObject({ ok: false, error: { code: "NOT_HOST" } });
    for (let index = 0; index < 6; index++) {
      expect((await host.emit("dev:add-bot", {})).ok).toBe(true);
    }
    // 2 Menschen + 6 Bots = 8 = voll.
    expect(await host.emit("dev:add-bot", {})).toMatchObject({ ok: false, error: { code: "LOBBY_FULL" } });
    await guest.emit("lobby:leave", {});
    // Host + 7 Bots: das Bot-Maximum (7) und die Lobby-Grenze (8) sind erreicht.
    expect((await host.emit("dev:add-bot", {})).ok).toBe(true);
    expect(await host.emit("dev:add-bot", {})).toMatchObject({ ok: false, error: { code: "LOBBY_FULL" } });
    const started = host.waitFor("lobby:state", (state) => state.phase === "intro");
    expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    await started;
    expect(await host.emit("dev:add-bot", {})).toMatchObject({ ok: false, error: { code: "INVALID_PHASE" } });
    host.close();
    guest.close();
  });
});
