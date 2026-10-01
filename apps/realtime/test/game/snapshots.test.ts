/**
 * Lobby-Snapshots (docs/04 lobbies, docs/07 §Graceful Shutdown): `persist` schreibt entprellt den aktuellen
 * Stand; die Lobby-Metrik folgt der Registry; der Shutdown-Hook friert alle Lobbys ein und sichert ihren
 * aktuellen Stand (Wiederaufnahme nach Neustart folgt in W4 – hier nur: korrekt geschrieben).
 */
import { randomInt, randomUUID } from "node:crypto";
import { createLobby, createSeededRng } from "@quizmaster/game-engine";
import { LOBBY_CODE_ALPHABET } from "@quizmaster/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eventually, metricValue, type TestServer } from "../helpers/index.ts";
import {
  actorOf,
  autoPlay,
  connectGuest,
  createLobby as createLobbyVia,
  joinLobby,
  runtimeOf,
  startGameServer,
} from "./support.ts";

/** Zufälliger gültiger Lobby-Code (nur für direkt übernommene Zustände). */
function code6(): string {
  let code = "";
  for (let index = 0; index < 6; index++) code += LOBBY_CODE_ALPHABET[randomInt(LOBBY_CODE_ALPHABET.length)];
  return code;
}

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startGameServer();
});
afterAll(() => server?.cleanup());

describe("Snapshots", () => {
  it("persist schreibt entprellt den aktuellen Stand (rev, Personen mit guestId, Einstellungen)", async () => {
    const host = await connectGuest(server);
    const code = await createLobbyVia(host, "Mia");
    const guest = await connectGuest(server);
    await joinLobby(guest, code, "Ben");
    expect(await host.emit("lobby:update-settings", { rounds: 5 })).toEqual({ ok: true, data: null });
    const actor = actorOf(server, code);
    await eventually(async () => (await server.db.repos.lobbies.findById(actor.lobbyId))?.rev === actor.state.rev);
    const doc = await server.db.repos.lobbies.findById(actor.lobbyId);
    expect(doc).toMatchObject({ code, active: true, phase: "lobby", settings: { rounds: 5 } });
    expect(doc?.players.map((player) => player.guestId)).toEqual([host.guestId, guest.guestId]);
    expect(doc?.createdByGuestId).toBe(host.guestId);
    expect((doc?.expiresAt.getTime() ?? 0) - (doc?.updatedAt.getTime() ?? 0)).toBe(30 * 60_000);
    host.close();
    guest.close();
  });

  it("die Lobby-Metrik folgt der Registry", async () => {
    const client = await connectGuest(server);
    await createLobbyVia(client);
    const runtime = runtimeOf(server);
    expect(await metricValue(server.app.services.metrics, "qm_lobbies_active")).toBe(runtime.lobbies.size);
    client.close();
    await eventually(
      async () => (await metricValue(server.app.services.metrics, "qm_lobbies_active")) === runtime.lobbies.size,
    );
  });

  it("adopt (Wiederaufnahme-Schnittstelle für W4): Zustand übernehmen, Timer laufen, Mitglieder können zurück", async () => {
    const runtime = runtimeOf(server);
    const guestId = randomUUID();
    const code = code6();
    const created = createLobby(
      { code, guestId, name: "Mia", timing: "fast" },
      { now: Date.now(), rng: createSeededRng("adopt") },
    );
    if (!created.ok) throw new Error(created.error.code);
    const actor = await runtime.lobbies.adopt(created.state);
    expect(runtime.lobbies.get(code)).toBe(actor);
    expect(runtime.lobbies.membershipsOf(guestId)).toEqual([actor]);
    await expect(runtime.lobbies.adopt(created.state)).rejects.toThrow(/bereits aktiv/);
    const client = await connectGuest(server, { guestId });
    const self = client.waitFor("lobby:self");
    expect(await client.emit("lobby:resume", { code })).toEqual({ ok: true, data: { code } });
    expect((await self).isHost).toBe(true);
    // Ohne Verbindung greift die Schließfrist aus dem übernommenen Zustand (fast: 2 s).
    client.close();
    await eventually(() => runtime.lobbies.get(code) === undefined, 10_000);
    expect(runtime.lobbies.membershipsOf(guestId)).toEqual([]);
  });

  it("Shutdown: alle Lobbys werden eingefroren und mit dem aktuellen Stand gesichert", async () => {
    const host = await connectGuest(server);
    const code = await createLobbyVia(host, "Mia");
    const guest = await connectGuest(server);
    await joinLobby(guest, code, "Ben");
    const players = [
      autoPlay(server, host, code, { answer: "none" }),
      autoPlay(server, guest, code, { answer: "none" }),
    ];
    const question = host.waitFor("lobby:state", (state) => state.phase === "question", 20_000);
    expect((await host.emit("lobby:start", {})).ok).toBe(true);
    await question;
    const actor = actorOf(server, code);
    await server.app.stop("test-shutdown");
    for (const player of players) player.stop();
    const doc = await server.db.repos.lobbies.findById(actor.lobbyId);
    expect(doc?.rev).toBe(actor.state.rev);
    expect(doc?.phase).toBe(actor.state.phase);
    expect(doc?.active).toBe(true);
    expect(doc?.game).not.toBeNull();
    // Eingefroren: keine Commands mehr (auch keine Timer), der gesicherte Stand bleibt der letzte.
    const after = await actor.dispatch({ type: "LEAVE", guestId: guest.guestId });
    expect(after).toMatchObject({ ok: false, error: { code: "SERVER_BUSY" } });
    const rev = actor.state.rev;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(actor.state.rev).toBe(rev);
  });
});
