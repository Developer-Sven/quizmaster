/**
 * `pnpm admin:game purge` (scripts/ops/lib/admin.ts) gegen echte Spiele dieses Servers: Der Spielabschluss verbucht
 * die Statistik über `buildGameStats` + `finishGame` (Transaktion); die Bereinigung muss genau das zurückrechnen –
 * Fragen-Statistik, Bewertungen/Meldungen und Gäste ohne weitere Spiele landen wieder beim Stand vor dem Spiel.
 * Laufende Lobbys bleiben unangetastet; die Bereinigung ist idempotent und der Dry-Run schreibt nichts.
 */
import type { GuestDoc, QuestionDoc } from "@quizmaster/shared/documents";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describePurge, purgeGamesByCode } from "../../../../scripts/ops/lib/admin.ts";
import {
  actorOf,
  autoPlay,
  connectGuest,
  createLobby,
  joinLobby,
  waitForGameDoc,
  waitForPhase,
} from "../game/support.ts";
import { eventually, type TestClient, type TestServer } from "../helpers/index.ts";
import { startSecurityServer } from "./support.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startSecurityServer({ devBots: true });
});
afterAll(() => server?.cleanup());

type Stats = Pick<QuestionDoc, "_id" | "stats">;

async function questionStats(): Promise<Map<string, Stats["stats"]>> {
  const docs = await server.db.collections.questions.find({}, { projection: { stats: 1 } }).toArray();
  return new Map(docs.map((doc) => [doc._id, doc.stats]));
}

async function guestDoc(guestId: string): Promise<GuestDoc | null> {
  return server.db.collections.guests.findOne({ _id: guestId });
}

/** Spielt ein Spiel (1 Runde, 2 Fragen je Kategorie) mit Host, Gast und einem Bot bis game_over. */
async function playGame(host: TestClient, guest: TestClient, hostName: string): Promise<string> {
  const code = await createLobby(host, hostName);
  await joinLobby(guest, code, "Ben");
  expect((await host.emit("dev:add-bot", {})).ok).toBe(true);
  expect((await host.emit("lobby:update-settings", { rounds: 1, questionsPerCategory: 2 })).ok).toBe(true);
  const players = [
    autoPlay(server, host, code, { answer: "correct" }),
    autoPlay(server, guest, code, { answer: "wrong" }),
  ];
  const over = waitForPhase(host, "game_over", 90_000);
  expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
  await over;
  for (const player of players) player.stop();
  await waitForGameDoc(server, actorOf(server, code).lobbyId);
  return code;
}

describe("admin:game purge – echte Spiele", () => {
  it("rechnet Statistik, Bewertungen, Meldungen und Gäste exakt zurück; laufende Lobbys bleiben; idempotent", async () => {
    const host = await connectGuest(server, { guestDoc: true });
    const guest = await connectGuest(server, { guestDoc: true });
    const regular = await connectGuest(server, { guestDoc: true });
    const hostBefore = await guestDoc(host.guestId);
    const guestBefore = await guestDoc(guest.guestId);

    // Zweites Spiel des Gasts unter anderem Code (bleibt): der Gast ist danach „an einem anderen Spiel beteiligt“.
    const keepCode = await playGame(regular, guest, "Rolf");
    const afterKeep = await questionStats();
    const guestAfterKeep = await guestDoc(guest.guestId);

    const code = await playGame(host, guest, "Mia");
    // Bewertung und Meldung beider Menschen zu gezeigten Fragen dieses Spiels.
    const review = await host.emit("game:review", {});
    if (!review.ok) throw new Error(`game:review: ${review.error.code}`);
    const [first, second] = review.data;
    if (first === undefined || second === undefined) throw new Error("Rückblick zu kurz");
    expect((await host.emit("question:rate", { questionId: first.questionId, value: 1 })).ok).toBe(true);
    expect((await guest.emit("question:rate", { questionId: second.questionId, value: -1 })).ok).toBe(true);
    expect((await host.emit("question:report", { questionId: second.questionId, reason: "falsch" })).ok).toBe(true);
    expect(await server.db.collections.questionRatings.countDocuments({})).toBe(2);

    // Lobby läuft noch (game_over, Personen verbunden) → nichts wird angefasst.
    const running = await purgeGamesByCode(server.db.client, server.db.collections, code, { dryRun: false });
    expect(running).toMatchObject({ games: 0, skippedGames: 1, lobbies: 0 });
    expect(describePurge(running, false).join("\n")).toContain("laufenden Lobby");
    expect(await server.db.collections.games.countDocuments({ code })).toBe(1);

    // Alle trennen → die Lobby schließt (fast: 2 s ohne Verbundene) → Snapshot inaktiv.
    const lobbyId = actorOf(server, code).lobbyId;
    host.close();
    guest.close();
    await eventually(
      async () => (await server.db.collections.lobbies.findOne({ _id: lobbyId }))?.active === false,
      15_000,
    );

    // Dry-Run: zeigt die Wirkung, schreibt nichts.
    const preview = await purgeGamesByCode(server.db.client, server.db.collections, code.toLowerCase(), {
      dryRun: true,
    });
    expect(preview).toMatchObject({
      code,
      games: 1,
      skippedGames: 0,
      lobbies: 1,
      ratings: 2,
      reports: 1,
      guests: { participants: 2, rolledBack: 1, otherGames: 1, missing: 0 },
    });
    // Erwartung unabhängig aus dem games-Dokument: nur Menschen, je Teilnahme an einer aufgelösten Frage.
    const [game] = await server.db.collections.games.find({ code }).toArray();
    if (game === undefined) throw new Error("games-Dokument fehlt");
    const humans = new Set(game.players.filter((player) => !player.isBot).map((player) => player.playerId));
    const answers = game.turns.flatMap((turn) =>
      turn.questions.flatMap((question) => question.answers.filter((answer) => humans.has(answer.playerId))),
    );
    expect(preview.questions).toBe(new Set(game.turns.flatMap((turn) => turn.questions.map((q) => q.questionId))).size);
    expect(preview.shown).toBe(answers.length);
    expect(preview.correct).toBe(answers.filter((answer) => answer.correct).length);
    expect(preview.shown).toBeGreaterThan(0);
    // Lobby-Codes werden wiederverwendet: der Dry-Run zeigt je Spiel Zeitpunkte und Besetzung (ohne Namen/IDs).
    expect(preview.since).toBeNull();
    expect(preview.gameList).toEqual([{ startedAt: game.startedAt, endedAt: game.endedAt, players: 2, bots: 1 }]);
    const text = describePurge(preview, true).join("\n");
    expect(text).toContain("Dry-Run");
    expect(text).toContain(`beendet ${game.endedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(text).toContain("2 Personen + 1 Bot");
    for (const secret of [host.guestId, guest.guestId, "Mia", "Ben"]) expect(text.includes(secret)).toBe(false);
    expect(await server.db.collections.games.countDocuments({ code })).toBe(1);
    // --since grenzt auf Spiele ab diesem Zeitpunkt ein (ältere Spiele mit wiederverwendetem Code bleiben).
    const later = new Date(game.endedAt.getTime() + 1);
    const narrowed = await purgeGamesByCode(server.db.client, server.db.collections, code, {
      dryRun: true,
      since: later,
    });
    expect(narrowed).toMatchObject({ games: 0, skippedGames: 0, since: later, gameList: [] });
    expect(describePurge(narrowed, true).join("\n")).toContain(`seit ${later.toISOString()}`);
    expect(
      await purgeGamesByCode(server.db.client, server.db.collections, code, { dryRun: true, since: game.endedAt }),
    ).toMatchObject({ games: 1 });

    const done = await purgeGamesByCode(server.db.client, server.db.collections, code, { dryRun: false });
    expect(done).toEqual(preview);

    // Spiel, Snapshot, Bewertungen, Meldung weg; Fragen-Statistik wieder wie nach dem ersten (behaltenen) Spiel.
    expect(await server.db.collections.games.countDocuments({ code })).toBe(0);
    expect(await server.db.collections.lobbies.countDocuments({ _id: lobbyId })).toBe(0);
    expect(await server.db.collections.questionRatings.countDocuments({})).toBe(0);
    expect(await server.db.collections.questionReports.countDocuments({})).toBe(0);
    expect(await questionStats()).toEqual(afterKeep);
    // Host (nur dieses Spiel) wieder auf dem Stand davor; der Gast (weiteres Spiel) bleibt unverändert.
    const hostAfter = await guestDoc(host.guestId);
    expect(hostAfter?.stats).toEqual(hostBefore?.stats);
    expect(hostAfter?.recentQuestionIds).toEqual(hostBefore?.recentQuestionIds);
    const guestAfter = await guestDoc(guest.guestId);
    expect(guestAfter?.stats).not.toEqual(guestAfterKeep?.stats);
    expect(guestBefore?.stats.games).toBe(0);
    // Das behaltene Spiel ist unangetastet.
    expect(await server.db.collections.games.countDocuments({ code: keepCode })).toBe(1);

    // Idempotent: zweiter Lauf ohne Wirkung.
    const again = await purgeGamesByCode(server.db.client, server.db.collections, code, { dryRun: false });
    expect(again).toMatchObject({ games: 0, skippedGames: 0 });
    expect(await questionStats()).toEqual(afterKeep);
    regular.close();
  });
});
