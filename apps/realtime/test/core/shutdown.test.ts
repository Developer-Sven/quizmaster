/**
 * Geordneter Shutdown (docs/07, docs/12: SIGTERM → keine neuen Lobbys, notice SERVER_RESTART, Snapshots,
 * Verbindungen schließen, Exit < 10 s) über `app.stop()` – derselbe Pfad, den `index.ts` bei SIGTERM nimmt.
 */
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installProcessShutdown, SHUTDOWN_HARD_LIMIT_MS, SHUTDOWN_HOOK_TIMEOUT_MS } from "../../src/app.ts";
import { createSilentLogger } from "../../src/logger.ts";
import { timeSyncModule } from "../../src/registry/time-sync.ts";
import type { RealtimeModule } from "../../src/registry/types.ts";
import { startTestServer, type TestServer, waitForDisconnect } from "../helpers/index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

describe("stop() (SIGTERM-Pfad)", () => {
  let server: TestServer;
  const hookCalls: string[] = [];
  const duringShutdown: Record<string, unknown> = {};

  const shutdownProbe: RealtimeModule = {
    name: "shutdown-probe",
    setup({ registerEvent, onShutdown, services }) {
      registerEvent("lobby:create", () => ({ code: "ABC234" }));
      onShutdown(async (reason) => {
        hookCalls.push(reason);
        // Während der Hooks sind die Sockets noch offen: neue Lobbys werden abgelehnt, Health meldet 503.
        const probe = [...clientsForProbe][0];
        if (probe !== undefined) duringShutdown.create = await probe.emit("lobby:create", { name: "Mia" });
        duringShutdown.admission = services.admission.lobbyCreation(0);
        duringShutdown.health = (await server.request("/healthz")).status;
        duringShutdown.handshake = await server.tryConnect();
      });
    },
  };
  const clientsForProbe = new Set<Awaited<ReturnType<TestServer["connectClient"]>>>();

  beforeAll(async () => {
    server = await startTestServer({ seed: false, modules: [timeSyncModule, shutdownProbe] });
  });
  afterAll(() => server?.cleanup());

  it("sendet notice SERVER_RESTART, führt Hooks aus, schließt Sockets und Server – in unter 10 s", async () => {
    const first = await server.connectClient();
    const second = await server.connectClient();
    clientsForProbe.add(first);
    const notices = [first.waitFor("notice"), second.waitFor("notice")];
    const disconnects = [waitForDisconnect(first.socket), waitForDisconnect(second.socket)];

    const started = performance.now();
    const stopping = server.app.stop("SIGTERM");
    expect(server.app.stop("SIGTERM")).toBe(stopping);
    await stopping;
    const elapsed = performance.now() - started;

    expect(await Promise.all(notices)).toEqual([{ code: "SERVER_RESTART" }, { code: "SERVER_RESTART" }]);
    // Transport-Close (nicht „io server disconnect“): Clients verbinden sich danach selbst neu.
    expect(await Promise.all(disconnects)).toEqual(["transport close", "transport close"]);
    expect(hookCalls).toEqual(["SIGTERM"]);
    expect(duringShutdown.create).toMatchObject({ ok: false, error: { code: "SERVER_BUSY" } });
    expect(duringShutdown.admission).toBe("SERVER_BUSY");
    expect(duringShutdown.health).toBe(503);
    expect(duringShutdown.handshake).toMatchObject({ ok: false, failure: { code: "SERVER_BUSY" } });
    expect(server.app.services.lifecycle.isShuttingDown()).toBe(true);
    expect(server.app.services.connections.total()).toBe(0);
    expect(server.app.httpServer.listening).toBe(false);
    expect(elapsed).toBeLessThan(10_000);
    expect(first.contractViolations).toEqual([]);
    await expect(fetch(`${server.url}/healthz`)).rejects.toThrow();
  });
});

describe("stop() mit hängendem Hook", () => {
  let server: TestServer;

  const hanging: RealtimeModule = {
    name: "hanging-hook",
    setup({ onShutdown }) {
      onShutdown(() => new Promise<void>(() => undefined));
    },
  };

  beforeAll(async () => {
    server = await startTestServer({ seed: false, modules: [timeSyncModule, hanging] });
  });
  afterAll(() => server?.cleanup());

  it("bricht die Hooks nach der Frist ab und schließt trotzdem", async () => {
    const client = await server.connectClient();
    const disconnected = waitForDisconnect(client.socket, 15_000);
    const started = performance.now();
    await server.app.stop("SIGTERM");
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(SHUTDOWN_HOOK_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(10_000);
    expect(await disconnected).toBe("transport close");
    expect(server.app.httpServer.listening).toBe(false);
  });
});

describe("Prozess-Signale (installProcessShutdown)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(stop: (reason: string) => Promise<void>) {
    const source = new EventEmitter();
    const exit = vi.fn<(code: number) => void>();
    const afterStop = vi.fn(async () => undefined);
    const app = { stop: vi.fn(stop) };
    installProcessShutdown({ app, logger: createSilentLogger(), exit, afterStop, source, hardLimitMs: 9_000 });
    return { source, exit, afterStop, app };
  }

  it("SIGTERM → stop → afterStop → Exit 0; SIGINT ebenso", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const { source, exit, afterStop, app } = setup(async () => undefined);
      source.emit(signal);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(app.stop).toHaveBeenCalledWith(signal);
      expect(afterStop).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
    }
  });

  it("zweites Signal während des Shutdowns → sofort Exit 1", () => {
    const { source, exit, app } = setup(() => new Promise<void>(() => undefined));
    source.emit("SIGTERM");
    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    source.emit("SIGINT");
    expect(exit).toHaveBeenCalledWith(1);
    expect(app.stop).toHaveBeenCalledTimes(1);
  });

  it("hängender Shutdown → harte Grenze → Exit 1", () => {
    vi.useFakeTimers();
    const { source, exit } = setup(() => new Promise<void>(() => undefined));
    source.emit("SIGTERM");
    vi.advanceTimersByTime(8_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(SHUTDOWN_HARD_LIMIT_MS).toBeLessThan(10_000);
  });

  it("fehlgeschlagener Shutdown und unbehandelte Fehler → Exit 1", async () => {
    const failing = setup(async () => {
      throw new Error("kaputt");
    });
    failing.source.emit("SIGTERM");
    await vi.waitFor(() => expect(failing.exit).toHaveBeenCalledWith(1));

    const crash = setup(async () => undefined);
    crash.source.emit("uncaughtException", new Error("boom"));
    await vi.waitFor(() => expect(crash.exit).toHaveBeenCalledWith(1));
    expect(crash.app.stop).toHaveBeenCalledWith("uncaughtException");

    const rejection = setup(async () => undefined);
    rejection.source.emit("unhandledRejection", new Error("boom"));
    await vi.waitFor(() => expect(rejection.exit).toHaveBeenCalledWith(1));
    expect(rejection.app.stop).toHaveBeenCalledWith("unhandledRejection");
  });
});
