/**
 * Lastabwurf (docs/06 §DDoS-Schicht 5): Event-Loop-Verzögerung p99 > 200 ms (zwei 5-s-Fenster in Folge) oder
 * Verbindungszahl an der Grenze → neue Verbindungen und neue Lobbys `SERVER_BUSY`, laufende Spiele laufen weiter.
 *
 * Der Lag wird echt erzeugt (Event-Loop blockieren, Fenster auswerten). Damit das laufende Spiel nicht selbst
 * blockiert wird, hält der Test den erkannten Zustand danach für die Dauer des Spiels fest (Spy auf
 * `overloaded()`), statt den Prozess sekundenlang zu blockieren.
 */
import { defaultAppConfig } from "@quizmaster/shared/documents";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdmissionService } from "../../src/services/admission.ts";
import { createConnectionsService } from "../../src/services/connections.ts";
import { autoPlay, connectGuest, createLobby, joinLobby, waitForPhase } from "../game/support.ts";
import { metricValue, type TestServer } from "../helpers/index.ts";
import { startSecurityServer } from "./support.ts";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startSecurityServer();
});
afterAll(() => server?.cleanup());
afterEach(() => {
  vi.restoreAllMocks();
});

/** Blockiert die Event-Loop absichtlich (synchron). */
function block(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // absichtlich blockieren
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Erzeugt echten Lag in zwei ausgewerteten Fenstern → Lastabwurf aktiv. */
async function simulateLag(): Promise<void> {
  const eventLoop = server.app.services.metrics.eventLoop;
  await tick();
  eventLoop.sample();
  for (let window = 0; window < 2; window++) {
    await tick();
    block(300);
    await tick();
    eventLoop.sample();
  }
}

describe("Lastabwurf durch Event-Loop-Verzögerung", () => {
  it("p99 > 200 ms → neue Verbindungen und Lobbys SERVER_BUSY, das laufende Spiel läuft bis zum Ende weiter", async () => {
    const { metrics } = server.app.services;
    const host = await connectGuest(server, { guestDoc: true });
    const guest = await connectGuest(server, { guestDoc: true });
    const idle = await server.connectClient();
    const code = await createLobby(host, "Mia");
    await joinLobby(guest, code, "Ben");
    expect((await host.emit("lobby:update-settings", { rounds: 1, questionsPerCategory: 2 })).ok).toBe(true);
    const players = [
      autoPlay(server, host, code, { answer: "correct" }),
      autoPlay(server, guest, code, { answer: "wrong" }),
    ];
    const firstQuestion = waitForPhase(host, "question", 20_000);
    const over = waitForPhase(host, "game_over", 60_000);
    expect(await host.emit("lobby:start", {})).toEqual({ ok: true, data: null });
    await firstQuestion;

    await simulateLag();
    expect(metrics.eventLoop.p99Ms()).toBeGreaterThan(200);
    expect(metrics.eventLoop.overloaded()).toBe(true);
    // Zustand für die Dauer des Spiels festhalten (siehe Kopfkommentar).
    vi.spyOn(metrics.eventLoop, "overloaded").mockReturnValue(true);
    const rejectedBefore = await metricValue(metrics, "qm_connections_rejected_total", { reason: "overloaded" });

    const busy = await server.tryConnect();
    expect(busy.ok ? null : busy.failure.code).toBe("SERVER_BUSY");
    expect(await metricValue(metrics, "qm_connections_rejected_total", { reason: "overloaded" })).toBe(
      rejectedBefore + 1,
    );
    expect(await idle.emit("lobby:create", { name: "Lea" })).toMatchObject({
      ok: false,
      error: { code: "SERVER_BUSY" },
    });

    // Das laufende Spiel bleibt unberührt: alle Antworten angenommen, Ende regulär erreicht.
    const final = await over;
    for (const player of players) player.stop();
    expect(final.results?.ranking).toHaveLength(2);
    for (const player of players) {
      expect(player.rejected).toEqual([]);
      for (const ack of player.answerAcks) expect(ack).toEqual({ ok: true, data: { accepted: true } });
    }
    expect(players[0]?.answers).toBeGreaterThan(0);
    // Bestehende Verbindungen arbeiten weiter (Rückblick nach Spielende).
    expect((await guest.emit("game:review", {})).ok).toBe(true);

    // Ende der Überlast → wieder normal.
    vi.restoreAllMocks();
    await new Promise((resolve) => setTimeout(resolve, 60));
    metrics.eventLoop.sample();
    expect(metrics.eventLoop.overloaded()).toBe(false);
    const fresh = await server.connectClient();
    expect((await fresh.emit("lobby:create", { name: "Lea" })).ok).toBe(true);
    for (const client of [host, guest, idle, fresh]) client.close();
  });
});

describe("Lastabwurf an der Verbindungsgrenze", () => {
  let small: TestServer;

  beforeAll(async () => {
    small = await startSecurityServer({ seed: false, env: { MAX_CONNECTIONS: "3" } });
  });
  afterAll(() => small?.cleanup());

  it("MAX_CONNECTIONS erreicht → neue Verbindungen SERVER_BUSY, bestehende arbeiten weiter", async () => {
    const clients = [await small.connectClient(), await small.connectClient(), await small.connectClient()];
    const rejected = await small.tryConnect();
    expect(rejected.ok ? null : rejected.failure.code).toBe("SERVER_BUSY");
    for (const client of clients) expect((await client.emit("time:sync", { t0: 1 })).ok).toBe(true);
    for (const client of clients) client.close();
  });
});

describe("Zulassung neuer Lobbys (services/admission.ts)", () => {
  function admission(options: {
    shuttingDown?: boolean;
    overloaded?: boolean;
    connections?: number;
    enabled?: boolean;
  }) {
    const connections = createConnectionsService({ perGuest: 5, perIp: 100, global: 4 });
    vi.spyOn(connections, "total").mockReturnValue(options.connections ?? 0);
    const config = {
      ...defaultAppConfig(new Date(0)),
      maxActiveLobbies: 10,
      lobbyCreationEnabled: options.enabled ?? true,
    };
    return createAdmissionService({
      lifecycle: { isShuttingDown: () => options.shuttingDown ?? false },
      appConfig: { get: () => config },
      metrics: { eventLoop: { overloaded: () => options.overloaded ?? false } },
      connections,
    });
  }

  it("Reihenfolge: Shutdown → Kill-Switch → Event-Loop → Verbindungsgrenze → maxActiveLobbies", () => {
    expect(admission({}).lobbyCreation(0)).toBeNull();
    expect(admission({ shuttingDown: true, enabled: false }).lobbyCreation(0)).toBe("SERVER_BUSY");
    expect(admission({ enabled: false, overloaded: true }).lobbyCreation(0)).toBe("LOBBY_CREATION_DISABLED");
    expect(admission({ overloaded: true }).lobbyCreation(0)).toBe("SERVER_BUSY");
    expect(admission({ connections: 3 }).lobbyCreation(0)).toBeNull();
    expect(admission({ connections: 4 }).lobbyCreation(0)).toBe("SERVER_BUSY");
    expect(admission({}).lobbyCreation(9)).toBeNull();
    expect(admission({}).lobbyCreation(10)).toBe("SERVER_BUSY");
  });
});
