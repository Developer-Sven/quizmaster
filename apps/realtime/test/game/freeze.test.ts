/**
 * Netzaussetzer (ADR-057) über echte Sockets: Hört der Server `SILENCE_MS` lang von keiner aktiven Person etwas,
 * friert er das Spiel ein (`frozen` im Zustand) – rückwirkend ab dem letzten Lebenszeichen. Das nächste Paket
 * (spätestens der Ping alle 5 s) taut es auf; die Frage läuft mit verschobenen Zeiten weiter.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eventually, type TestClient, type TestServer } from "../helpers/index.ts";
import {
  actorOf,
  connectGuest,
  createLobby,
  joinLobby,
  runtimeOf,
  serverSocketOf,
  sleep,
  startGameServer,
  waitForPhase,
} from "./support.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let server: TestServer;
/** Verschiebt die Serverzeit: so sieht es für den Server aus, als hätte er so lange nichts gehört. */
let offsetMs = 0;

beforeAll(async () => {
  server = await startGameServer({ clock: { now: () => Date.now() + offsetMs } });
});
afterAll(() => server?.cleanup());

describe("Netzaussetzer (ADR-057)", () => {
  it("Stille → eingefroren; nächstes Lebenszeichen → aufgetaut, die Frage läuft mit verschobenen Zeiten weiter", async () => {
    const host = await connectGuest(server, { guestDoc: true });
    const code = await createLobby(host);
    const ben = await connectGuest(server, { guestDoc: true });
    await joinLobby(ben, code, "Ben");
    // Die Frage bleibt offen, bis der Host auflöst – so hängt nichts am Takt des Testmodus. Eine feste Kategorie:
    // keine Wahl, ein Zug (ADR-056).
    const [only] = runtimeOf(server).questions.playableCategories();
    if (!only) throw new Error("Keine spielbare Kategorie");
    const settings = { answerSec: 0, rounds: 1, questionsPerCategory: 1, categoryIds: [only.id] };
    expect((await host.emit("lobby:update-settings", settings)).ok).toBe(true);
    expect((await host.emit("lobby:start", {})).ok).toBe(true);
    const open = await host.waitFor(
      "lobby:state",
      (state) => state.phase === "question" && state.question !== null,
      15_000,
    );
    // Erst nach dem Vorlauf ist die Frage offen.
    await eventually(() => (open.question?.startsAt ?? 0) <= Date.now() + offsetMs, 10_000);
    const startsAt = open.question?.startsAt ?? 0;

    const frozen = ben.waitFor("lobby:state", (state) => state.frozen, 15_000);
    offsetMs += 9_000;
    await frozen;
    const thawed = await ben.waitFor("lobby:state", (state) => !state.frozen, 15_000);
    expect(thawed.phase).toBe("question");
    // Rückwirkend eingefroren: mindestens die 9 s „Stille“ kommen zurück.
    expect(thawed.question?.startsAt ?? 0).toBeGreaterThanOrEqual(startsAt + 9_000);

    // Lag das letzte Lebenszeichen noch im Vorlauf, beginnt die Frage nach dem restlichen Vorlauf erneut.
    await eventually(() => (thawed.question?.startsAt ?? 0) <= Date.now() + offsetMs, 15_000);
    expect((await host.emit("game:continue", { phase: "question" })).ok).toBe(true);
    await waitForPhase(ben, "game_over", 30_000);
    host.close();
    ben.close();
  });
});

describe("Netzaussetzer: Kommando über einen noch nicht gebundenen Socket (ADR-057)", () => {
  it("taut vor dem Kommando auf und hält die Lobby wach – die sekündliche Prüfung friert nicht gleich wieder ein", async () => {
    // Normales Timing: Reconnect-Frist 90 s – im Testmodus schieden die Getrennten schon nach 5 s aus.
    const normal = await startGameServer({ timing: "normal" });
    try {
      const host = await connectGuest(normal, { guestDoc: true });
      const code = await createLobby(host);
      const ben = await connectGuest(normal, { guestDoc: true });
      await joinLobby(ben, code, "Ben");
      const [only] = runtimeOf(normal).questions.playableCategories();
      if (!only) throw new Error("Keine spielbare Kategorie");
      const settings = { answerSec: 0, rounds: 1, questionsPerCategory: 1, categoryIds: [only.id] };
      expect((await host.emit("lobby:update-settings", settings)).ok).toBe(true);
      expect((await host.emit("lobby:start", {})).ok).toBe(true);
      const open = await ben.waitFor(
        "lobby:state",
        (state) => state.phase === "question" && state.question !== null,
        30_000,
      );
      await eventually(() => (open.question?.startsAt ?? 0) <= Date.now(), 15_000);
      const actor = actorOf(normal, code);

      // Ein zweiter Socket von Ben ohne `lobby:resume` (etwa direkt nach einem Reconnect) – dann reißen beide
      // gebundenen Verbindungen ab: Von keiner aktiven Person kommt mehr etwas, die Lobby friert ein.
      const benAgain = await connectGuest(normal, { guestId: ben.guestId });
      host.close();
      ben.close();
      await eventually(() => actor.state.frozen !== null, 10_000);

      const answer = await benAgain.emit("game:answer", { questionId: open.question?.id ?? "", choice: 0 });
      expect(answer).toEqual({ ok: true, data: { accepted: true } });
      expect(actor.state.frozen).toBeNull();
      // Ben ist zu hören: Die nächsten Prüfungen (jede Sekunde) frieren nicht sofort wieder ein.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(actor.state.frozen).toBeNull();
      benAgain.close();
    } finally {
      await normal.cleanup();
    }
  });
});

/**
 * Netzaussetzer am Gerät bzw. auf dem Weg: Der Client puffert alles, was er sendet – auch die Antwort auf den Ping des
 * Servers. Beim Server kommt nichts mehr an, wie bei einem echten Aussetzer.
 */
function stopSending(client: TestClient): void {
  client.socket.io.engine.transport.writable = false;
}

describe("Netzaussetzer: gestaffelte Rückkehr nach dem Ping-Timeout (ADR-060)", () => {
  it("die erste zurückkehrende Person löst nicht für alle auf – wer gleich nachkommt, beantwortet die Frage noch", async () => {
    // Normales Timing: frühe Auflösung nach 700 ms, Schonfrist 15 s, Reconnect-Frist 90 s.
    const normal = await startGameServer({ timing: "normal" });
    const clients: TestClient[] = [];
    try {
      const host = await connectGuest(normal, { guestDoc: true });
      const code = await createLobby(host);
      const ben = await connectGuest(normal, { guestDoc: true });
      await joinLobby(ben, code, "Ben");
      const lea = await connectGuest(normal, { guestDoc: true });
      await joinLobby(lea, code, "Lea");
      clients.push(host, ben, lea);
      const [only] = runtimeOf(normal).questions.playableCategories();
      if (!only) throw new Error("Keine spielbare Kategorie");
      // Ohne Countdown (ADR-049): Die Frage bleibt offen, bis alle geantwortet haben – nichts hängt am Takt.
      const settings = { answerSec: 0, rounds: 1, questionsPerCategory: 1, categoryIds: [only.id] };
      expect((await host.emit("lobby:update-settings", settings)).ok).toBe(true);
      expect((await host.emit("lobby:start", {})).ok).toBe(true);
      const open = await lea.waitFor(
        "lobby:state",
        (state) => state.phase === "question" && state.question !== null,
        30_000,
      );
      await eventually(() => (open.question?.startsAt ?? 0) <= Date.now(), 15_000);
      const questionId = open.question?.id ?? "";
      expect((await host.emit("game:answer", { questionId, choice: 0 })).ok).toBe(true);
      expect((await ben.emit("game:answer", { questionId, choice: 0 })).ok).toBe(true);
      const actor = actorOf(normal, code);

      // Aussetzer: Von keinem Gerät kommt mehr etwas an → nach 8 s eingefroren. Dann trennt das Ping-Timeout alle
      // (hier sofort, statt 20 s zu warten).
      for (const client of [host, ben, lea]) stopSending(client);
      await eventually(() => actor.state.frozen !== null, 15_000);
      for (const client of [host, ben, lea]) serverSocketOf(normal, client).disconnect(true);
      await eventually(() => actor.state.players.every((player) => !player.connected), 5_000);
      for (const client of [host, ben, lea]) client.close();

      // Das Netz ist zurück – die Geräte kommen nacheinander (Backoff, Ticket, Handshake). Der Host taut auf.
      const hostAgain = await connectGuest(normal, { guestId: host.guestId });
      clients.push(hostAgain);
      expect((await hostAgain.emit("lobby:resume", { code })).ok).toBe(true);
      await eventually(() => actor.state.frozen === null, 5_000);
      await sleep(1_500);
      expect(actor.state.phase).toBe("question");
      const benAgain = await connectGuest(normal, { guestId: ben.guestId });
      clients.push(benAgain);
      expect((await benAgain.emit("lobby:resume", { code })).ok).toBe(true);
      await sleep(1_500);
      expect(actor.state.phase).toBe("question");
      const leaAgain = await connectGuest(normal, { guestId: lea.guestId });
      clients.push(leaAgain);
      expect((await leaAgain.emit("lobby:resume", { code })).ok).toBe(true);
      expect(await leaAgain.emit("game:answer", { questionId, choice: 0 })).toEqual({
        ok: true,
        data: { accepted: true },
      });
      // Jetzt haben alle geantwortet: frühe Auflösung wie gewohnt.
      await waitForPhase(leaAgain, "reveal", 10_000);
    } finally {
      for (const client of clients) client.close();
      await normal.cleanup();
    }
  });
});
