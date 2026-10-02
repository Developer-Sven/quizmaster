/**
 * Invariante 4 (docs/06, docs/11 §Sicherheits-Invarianten 4): Die guestId taucht in KEINEM Server→Client-Datum
 * auf. Stichprobe über ein komplettes Spiel mit allen Server-Events (`lobby:state`, `lobby:self`, `notice` mit
 * HOST_CHANGED/PLAYER_LEFT/MAINTENANCE/SERVER_RESTART, `kicked`) und den Acks aller Client-Events – geprüft auf
 * das Feld `guestId` UND auf die Werte (guestIds aller Menschen und die synthetischen IDs der Bots) irgendwo
 * im serialisierten Datum.
 */
import { randomUUID } from "node:crypto";
import {
  CLIENT_EVENT_NAMES,
  CLIENT_FORBIDDEN_KEYS,
  type ClientEventName,
  findKeysDeep,
  SERVER_EVENT_NAMES,
} from "@quizmaster/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { actorOf, autoPlay, connectGuest, lastSelf, lastState, waitForGameDoc, waitForPhase } from "../game/support.ts";
import { eventually, type TestClient, type TestServer } from "../helpers/index.ts";
import { recordAcks, type ServerDatum, serverData, startSecurityServer } from "./support.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startSecurityServer({ devBots: true });
});
afterAll(() => server?.cleanup());

describe("Invariante 4 – keine guestId in Server→Client-Daten", () => {
  it("komplettes Spiel mit Bot, Kick, Aufgeben, Resume, Rückblick, Feedback, Host-Wechsel, Wartung und Neustart", async () => {
    const acks: ServerDatum[] = [];
    const clients: TestClient[] = [];
    const join = async (options: Parameters<typeof connectGuest>[1] = {}) => {
      const client = await connectGuest(server, { guestDoc: true, ...options });
      clients.push(client);
      return { client, act: recordAcks(client, acks) };
    };
    const host = await join();
    const guest = await join();
    const leaver = await join();
    const kicked = await join();

    const created = await host.act.emit("lobby:create", { name: "Mia" });
    if (!created.ok) throw new Error(`lobby:create: ${created.error.code}`);
    const code = created.data.code;
    for (const [entry, name] of [
      [guest, "Ben"],
      [leaver, "Lea"],
      [kicked, "Kai"],
    ] as const) {
      const self = entry.client.waitFor("lobby:self");
      expect((await entry.act.emit("lobby:join", { code, name })).ok).toBe(true);
      await self;
    }
    expect((await host.act.emit("dev:add-bot", {})).ok).toBe(true);
    // Zwischenstand per Host (ADR-045): so kommt auch game:continue vor.
    expect(
      (await host.act.emit("lobby:update-settings", { rounds: 1, questionsPerCategory: 1, afterRoundSec: 0 })).ok,
    ).toBe(true);
    expect((await guest.act.emit("lobby:rename", { name: "Benni" })).ok).toBe(true);
    // Vorschläge (ADR-053): vorschlagen, zurückziehen, erneut vorschlagen; der Host lehnt ab bzw. übernimmt.
    expect((await guest.act.emit("lobby:suggest-settings", { rounds: 2 })).ok).toBe(true);
    expect((await guest.act.emit("lobby:withdraw-suggestion", {})).ok).toBe(true);
    expect((await guest.act.emit("lobby:suggest-settings", { rounds: 2 })).ok).toBe(true);
    await eventually(() => lastState(host.client)?.suggestions[0]?.status === "pending");
    const declinedId = lastState(host.client)?.suggestions[0]?.id ?? "";
    expect((await host.act.emit("lobby:decline-suggestion", { id: declinedId })).ok).toBe(true);
    expect((await guest.act.emit("lobby:suggest-settings", { questionsPerCategory: 2 })).ok).toBe(true);
    await eventually(() => lastState(host.client)?.suggestions[0]?.status === "pending");
    const acceptedId = lastState(host.client)?.suggestions[0]?.id ?? "";
    expect(
      (await host.act.emit("lobby:accept-suggestion", { id: acceptedId, changes: { questionsPerCategory: 1 } })).ok,
    ).toBe(true);
    // Host kurz übertragen und zurück (ADR-047) – so kommt auch lobby:transfer-host vor.
    const guestPlayerId = lastSelf(guest.client)?.playerId ?? "";
    const hostPlayerId = lastSelf(host.client)?.playerId ?? "";
    expect((await host.act.emit("lobby:transfer-host", { playerId: guestPlayerId })).ok).toBe(true);
    await eventually(() => lastSelf(guest.client)?.isHost === true);
    expect((await guest.act.emit("lobby:transfer-host", { playerId: hostPlayerId })).ok).toBe(true);
    await eventually(() => lastSelf(host.client)?.isHost === true);
    expect((await host.act.emit("time:sync", { t0: 1 })).ok).toBe(true);

    // Kick: kicked { host } an die Person, danach resume → KICKED.
    const kickedNotice = kicked.client.waitFor("kicked");
    const kickedId = lastSelf(kicked.client)?.playerId ?? "";
    expect((await host.act.emit("lobby:kick", { playerId: kickedId })).ok).toBe(true);
    expect(await kickedNotice).toEqual({ reason: "host" });
    expect(await kicked.act.emit("lobby:resume", { code })).toMatchObject({ ok: false, error: { code: "KICKED" } });

    // Spiel: Host und Gast spielen, „leaver“ gibt in der ersten Frage auf (notice PLAYER_LEFT).
    const players = [
      autoPlay(server, host.client, code, { answer: "correct" }),
      autoPlay(server, guest.client, code, { answer: "wrong" }),
    ];
    const playerLeft = guest.client.waitFor("notice", (notice) => notice.code === "PLAYER_LEFT", 30_000);
    const firstQuestion = waitForPhase(leaver.client, "question", 30_000);
    const over = waitForPhase(host.client, "game_over", 90_000);
    expect(await host.act.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    await firstQuestion;
    expect((await leaver.act.emit("lobby:leave", {})).ok).toBe(true);
    await playerLeft;

    // Zweiter Tab des Gasts mitten im Spiel: resume liefert lobby:state + lobby:self.
    const secondTab = await join({ guestId: guest.client.guestId, guestDoc: false });
    const resumedSelf = secondTab.client.waitFor("lobby:self");
    expect(await secondTab.act.emit("lobby:resume", { code })).toEqual({ ok: true, data: { code } });
    await resumedSelf;
    secondTab.client.close();

    // Rundentafel wartet auf den Host („Weiter“, ADR-045).
    await waitForPhase(host.client, "round_board", 60_000);
    expect(await host.act.emit("game:continue", { phase: "round_board" })).toEqual({ ok: true, data: null });
    await over;
    for (const player of players) player.stop();
    const actor = actorOf(server, code);
    await waitForGameDoc(server, actor.lobbyId);

    // Rückblick, Bewertung, Meldung (Acks mit playerIds, nie guestIds).
    const review = await guest.act.emit("game:review", {});
    if (!review.ok) throw new Error(`game:review: ${review.error.code}`);
    const first = review.data[0];
    if (first === undefined) throw new Error("Rückblick leer");
    expect((await guest.act.emit("question:rate", { questionId: first.questionId, value: -1 })).ok).toBe(true);
    expect((await guest.act.emit("question:report", { questionId: first.questionId, reason: "mehrdeutig" })).ok).toBe(
      true,
    );
    expect((await host.act.emit("game:review", {})).ok).toBe(true);

    // Synthetische Bot-ID aus dem Server-Zustand (darf ebenso nie hinaus).
    const botGuestIds = actor.state.players.filter((player) => player.isBot).map((player) => player.guestId);
    expect(botGuestIds).toHaveLength(1);

    // Wartung live (Watcher): notice MAINTENANCE an alle.
    const maintenance = guest.client.waitFor("notice", (notice) => notice.code === "MAINTENANCE", 10_000);
    await server.db.repos.appConfig.update({ maintenance: { enabled: true, message: "Kurz weg" } }, new Date());
    await maintenance;
    await server.db.repos.appConfig.update({ maintenance: { enabled: false, message: null } }, new Date());

    // Host verlässt die Lobby nach dem Spiel → HOST_CHANGED; der neue Host startet die Revanche (mit Bot).
    const hostChanged = guest.client.waitFor("notice", (notice) => notice.code === "HOST_CHANGED", 10_000);
    expect((await host.act.emit("lobby:leave", {})).ok).toBe(true);
    await hostChanged;
    const rematch = waitForPhase(guest.client, "intro", 10_000);
    const guestBack = autoPlay(server, guest.client, code, { answer: "correct" });
    expect(await guest.act.emit("game:rematch", {})).toEqual({ ok: true, data: null });
    await rematch;
    const pick = guest.client.waitFor("lobby:state", (state) => state.phase === "category_pick", 10_000);
    await pick;
    guestBack.stop();
    // game:pick und game:answer (auch abgelehnte) liefern nur Codes bzw. { accepted: true }.
    await guest.act.emit("game:pick", { categoryId: "gibt-es-nicht" });
    await guest.act.emit("game:answer", { questionId: "q-unbekannt", choice: 0 });
    // Der neue Host beendet die Revanche vorzeitig (ADR-051): notice GAME_ENDED, Ergebnis.
    const ended = guest.client.waitFor("lobby:state", (state) => state.phase === "game_over", 10_000);
    expect(await guest.act.emit("game:end", {})).toEqual({ ok: true, data: null });
    await ended;

    // Neustart: notice SERVER_RESTART an alle noch verbundenen Sockets.
    const restart = guest.client.waitFor("notice", (notice) => notice.code === "SERVER_RESTART", 10_000);
    await server.app.stop("test");
    await restart;

    // --- Auswertung ---------------------------------------------------------------------------------------
    const secrets = [...clients.map((client) => client.guestId), ...botGuestIds];
    expect(new Set(secrets).size).toBe(clients.length - 1 + botGuestIds.length); // zweiter Tab = gleicher Gast
    const data = clients.flatMap((client) => serverData(client)).concat(acks);
    expect(data.length).toBeGreaterThan(50);
    for (const datum of data) {
      const where = `${datum.kind} ${datum.name}`;
      expect(findKeysDeep(datum.payload, CLIENT_FORBIDDEN_KEYS), where).toEqual([]);
      const text = JSON.stringify(datum.payload);
      for (const secret of secrets) expect(text.includes(secret), `${where} enthält eine guestId`).toBe(false);
      expect(text.includes("bot:"), `${where} enthält eine Bot-guestId`).toBe(false);
    }
    for (const client of clients) expect(client.contractViolations).toEqual([]);

    // Abdeckung der Stichprobe: alle Server-Events, alle Hinweis-Codes, Acks aller Client-Events.
    const events = new Set(data.filter((datum) => datum.kind === "event").map((datum) => datum.name));
    expect([...events].sort()).toEqual([...SERVER_EVENT_NAMES].sort());
    const notices = new Set(
      data
        .filter((datum) => datum.kind === "event" && datum.name === "notice")
        .map((datum) => (datum.payload as { code: string }).code),
    );
    expect([...notices].sort()).toEqual(["GAME_ENDED", "HOST_CHANGED", "MAINTENANCE", "PLAYER_LEFT", "SERVER_RESTART"]);
    const acked = new Set(data.filter((datum) => datum.kind === "ack").map((datum) => datum.name as ClientEventName));
    const expected = CLIENT_EVENT_NAMES.filter((event) => event !== "game:answer" && event !== "game:pick");
    for (const event of expected) expect(acked.has(event), `Ack ${event}`).toBe(true);
    expect(acked.has("game:answer") && acked.has("game:pick")).toBe(true);
  });

  it("auch Acks auf ungültige Eingaben enthalten nie eine guestId", async () => {
    // Eigener Server: der erste wurde im Test oben gestoppt.
    const fresh = await startSecurityServer({ seed: false });
    try {
      const guestId = randomUUID();
      const client = await fresh.connectClient({ guestId });
      const acks: ServerDatum[] = [];
      const act = recordAcks(client, acks);
      await act.emit("lobby:join", { code: "ZZZZZZ", name: "Mia" });
      await act.emit("lobby:resume", { code: "ZZZZZZ" });
      await act.emit("lobby:create", { name: "admin" });
      await act.emit("lobby:kick", { playerId: guestId });
      await eventually(() => client.socket.connected);
      for (const datum of serverData(client, acks)) {
        expect(JSON.stringify(datum.payload).includes(guestId), datum.name).toBe(false);
      }
      client.close();
    } finally {
      await fresh.cleanup();
    }
  });
});
