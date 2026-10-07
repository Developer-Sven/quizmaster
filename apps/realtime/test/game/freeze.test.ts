/**
 * Netzaussetzer (ADR-057) über echte Sockets: Hört der Server `SILENCE_MS` lang von keiner aktiven Person etwas,
 * friert er das Spiel ein (`frozen` im Zustand) – rückwirkend ab dem letzten Lebenszeichen. Das nächste Paket
 * (spätestens der Ping alle 5 s) taut es auf; die Frage läuft mit verschobenen Zeiten weiter.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eventually, type TestServer } from "../helpers/index.ts";
import { connectGuest, createLobby, joinLobby, runtimeOf, startGameServer, waitForPhase } from "./support.ts";

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
