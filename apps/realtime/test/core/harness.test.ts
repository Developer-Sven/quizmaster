/** Test-Harness selbst: Standardpfad für Lobby/Spiel-Tests (Fixtures geseedet, fast-Timing, Dev-Bots). */
import { CLIENT_EVENT_NAMES, PROTOCOL_VERSION } from "@quizmaster/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { roomForGuest, roomForLobby } from "../../src/registry/rooms.ts";
import { timeSyncModule } from "../../src/registry/time-sync.ts";
import type { AppSocket, RealtimeModule } from "../../src/registry/types.ts";
import {
  eventually,
  FIXTURES_CONTENT_DIR,
  loadFixtureCatalog,
  startTestServer,
  type TestServer,
} from "../helpers/index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

describe("startTestServer (Standardoptionen)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer({ devBots: true });
  });
  afterAll(() => server?.cleanup());

  it("seedet die Fixtures in die Test-DB und nutzt ein eigenes Präfix", async () => {
    const catalog = loadFixtureCatalog();
    expect(FIXTURES_CONTENT_DIR).toMatch(/test\/fixtures\/content$/);
    expect(catalog.categoriesFile.categories).toHaveLength(19);
    expect(server.database.dbName.endsWith("_test")).toBe(true);
    expect(server.db.collections.questions.collectionName.startsWith(server.database.prefix)).toBe(true);
    expect(await server.db.collections.categories.countDocuments({ playable: true })).toBe(19);
    const playable = await server.db.repos.questions.loadPool("all");
    expect(playable.length).toBeGreaterThan(150);
    expect((await server.db.repos.appConfig.get()).catalog.minPlayable).toBe(3);
  });

  it("startet mit fast-Timing, Dev-Bots und normalen Limits auf einem Port des Bereichs", () => {
    expect(server.env.GAME_TIMING).toBe("fast");
    expect(server.env.DEV_BOTS_ENABLED).toBe(true);
    expect(server.env.RATE_LIMIT_MODE).toBe("normal");
    expect(server.port).toBeGreaterThanOrEqual(4130);
    expect(server.port).toBeLessThanOrEqual(4139);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    // Mit dem Lobby/Spiel-Modul haben alle Events einen Handler – inkl. dev:add-bot (DEV_BOTS_ENABLED).
    expect(server.app.registry.missingHandlers()).toEqual([]);
    expect(server.app.registry.registeredEvents()).toContain("dev:add-bot");
    expect([...server.app.registry.registeredEvents(), ...server.app.registry.missingHandlers()].sort()).toEqual(
      [...CLIENT_EVENT_NAMES].sort(),
    );
  });

  it("Clients bekommen eigene simulierte IPs, Tickets und landen im Gast-Raum", async () => {
    const alice = await server.connectClient();
    const bob = await server.connectClient();
    expect(alice.ip).not.toBe(bob.ip);
    expect(alice.guestId).not.toBe(bob.guestId);
    expect(await server.app.io.in(roomForGuest(alice.guestId)).fetchSockets()).toHaveLength(1);
    expect(roomForLobby("ABC234")).toBe("lobby:ABC234");
    const ack = await alice.emit("time:sync", { t0: Date.now() });
    expect(ack.ok).toBe(true);
    expect(alice.contractViolations).toEqual([]);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
    alice.close();
    bob.close();
  });
});

describe("Modul-Hooks", () => {
  let server: TestServer;
  const events: string[] = [];
  const remainingAtDisconnect: number[] = [];

  const probe: RealtimeModule = {
    name: "hook-probe",
    setup({ onStart, onConnection, onDisconnect, services }) {
      onStart(() => {
        events.push(`start:${services.appConfig.get().minClientProtocol}`);
      });
      onConnection((socket: AppSocket) => {
        events.push(`connect:${socket.rooms.has(roomForGuest(socket.data.guestId))}`);
      });
      onDisconnect((socket: AppSocket, reason: string) => {
        remainingAtDisconnect.push(services.connections.countForGuest(socket.data.guestId));
        events.push(`disconnect:${reason}`);
      });
    },
  };

  beforeAll(async () => {
    server = await startTestServer({ seed: false, modules: [timeSyncModule, probe] });
  });
  afterAll(() => server?.cleanup());

  it("onStart vor listen (appConfig geladen), onConnection im Gast-Raum, onDisconnect mit aktualisierten Zählern", async () => {
    expect(events).toEqual(["start:1"]);
    const first = await server.connectClient();
    const second = await server.connectClient({ guestId: first.guestId });
    await eventually(() => events.filter((event) => event === "connect:true").length === 2);
    first.close();
    await eventually(() => remainingAtDisconnect.length === 1);
    second.close();
    await eventually(() => remainingAtDisconnect.length === 2);
    // Die Lobby-Schicht sendet DISCONNECT erst, wenn der letzte Socket einer Person weg ist (Zähler 0).
    expect(remainingAtDisconnect).toEqual([1, 0]);
    expect(events.filter((event) => event.startsWith("disconnect:"))).toEqual([
      "disconnect:client namespace disconnect",
      "disconnect:client namespace disconnect",
    ]);
  });
});
