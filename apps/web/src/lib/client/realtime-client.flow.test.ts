/**
 * Verbindungsablauf des Realtime-Clients gegen einen nachgebauten Socket (socket.io-client gemockt) und
 * gemocktes `fetch`: Session nur wenn nötig (Ticket zuerst), Ablehnungen erreichen wartende Aktionen,
 * gedeckelte Neuversuche, schemawidrige Zustände → Resync bzw. „Neue Version verfügbar“.
 */
import { PROTOCOL_VERSION } from "@quizmaster/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gameActions, useGameStore } from "../../stores/game-store";
import { getRealtimeClient, type RealtimeClient, rejectionRetryDelayMs } from "./realtime-client";
import { resetSessionForTests } from "./session";
import { testLobby, testSelf } from "./test-support";

type Handler = (...args: unknown[]) => void;
type AckResponder = (event: string, payload: unknown) => unknown;

/** Nachbau der benutzten Socket.IO-Client-Oberfläche. */
class FakeSocket {
  connected = false;
  active = false;
  connectCalls = 0;
  authData: unknown = null;
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  responder: AckResponder = (event, payload) => {
    if (event === "time:sync") return { ok: true, data: { serverNow: 1_000_000 } };
    if (event === "lobby:resume") return { ok: true, data: { code: (payload as { code: string }).code } };
    return { ok: false, error: { code: "INTERNAL", message: "x" } };
  };
  private readonly handlers = new Map<string, Handler[]>();
  private readonly managerHandlers = new Map<string, Handler[]>();
  /** Manager (`socket.io`): meldet den Ping vom Server (ADR-057). */
  readonly io = {
    on: (event: string, handler: Handler) => {
      this.managerHandlers.set(event, [...(this.managerHandlers.get(event) ?? []), handler]);
    },
    off: (event: string, handler: Handler) => {
      this.managerHandlers.set(
        event,
        (this.managerHandlers.get(event) ?? []).filter((entry) => entry !== handler),
      );
    },
  };
  private readonly anyHandlers: Handler[] = [];
  private readonly auth: (send: (data: object) => void) => void;

  constructor(options: { auth: (send: (data: object) => void) => void }) {
    this.auth = options.auth;
  }

  connect(): this {
    this.connectCalls += 1;
    this.active = true;
    this.authData = null;
    this.auth((data) => {
      this.authData = data;
    });
    return this;
  }

  disconnect(): this {
    const wasConnected = this.connected;
    this.active = false;
    this.connected = false;
    if (wasConnected) this.fire("disconnect", "io client disconnect");
    return this;
  }

  onAny(handler: Handler): this {
    this.anyHandlers.push(handler);
    return this;
  }

  /** Ping vom Server (Manager-Ereignis). */
  ping(): void {
    for (const handler of this.managerHandlers.get("ping") ?? []) handler();
  }

  on(event: string, handler: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  removeAllListeners(): this {
    this.handlers.clear();
    return this;
  }

  timeout(_ms: number) {
    return {
      emitWithAck: async (event: string, payload: unknown) => {
        this.emitted.push({ event, payload });
        return this.responder(event, payload);
      },
    };
  }

  /** Server nimmt die Verbindung an. */
  accept(): void {
    this.connected = true;
    this.active = true;
    this.fire("connect");
  }

  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  count(event: string): number {
    return this.emitted.filter((entry) => entry.event === event).length;
  }
}

const sockets: FakeSocket[] = [];

vi.mock("socket.io-client", () => ({
  io: (...args: unknown[]) => {
    const options = (args.length > 1 ? args[1] : args[0]) as ConstructorParameters<typeof FakeSocket>[0];
    const socket = new FakeSocket(options);
    sockets.push(socket);
    return socket;
  },
}));

const socket = (): FakeSocket => {
  const current = sockets.at(-1);
  if (!current) throw new Error("kein Socket erzeugt");
  return current;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn<typeof fetch>();
const requestedPaths = () => fetchMock.mock.calls.map(([url]) => String(url));

/** Antworten je Pfad der Reihe nach (letzte gilt danach weiter). */
function respond(routes: Record<string, Response[]>): void {
  const queues = new Map(Object.entries(routes).map(([path, responses]) => [path, [...responses]]));
  fetchMock.mockImplementation(async (url) => {
    const queue = queues.get(String(url));
    if (!queue || queue.length === 0) throw new TypeError(`unerwarteter Request ${String(url)}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return (next as Response).clone();
  });
}

const memory = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, String(value));
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
};

let urlCounter = 0;
let client: RealtimeClient | null = null;

function newClient(): RealtimeClient {
  urlCounter += 1;
  client = getRealtimeClient({ realtimeUrl: `http://rt-${urlCounter}.test` });
  return client;
}

/** Microtasks und fällige Timer abarbeiten. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  memory.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: localStorageStub }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  resetSessionForTests();
  gameActions.resetAll();
});

afterEach(() => {
  client?.dispose();
  client = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Session nur wenn nötig – Ticket zuerst (docs/02, W2-Ablauf)", () => {
  it("erster Besuch (kein Merker): POST /api/session, dann Ticket; danach ist der Merker gesetzt", async () => {
    respond({ "/api/session": [json(201, { created: true })], "/api/realtime/ticket": [json(200, { ticket: "t-1" })] });
    newClient().connect();
    await flush();
    expect(socket().authData).toEqual({ ticket: "t-1", protocolVersion: PROTOCOL_VERSION });
    expect(requestedPaths()).toEqual(["/api/session", "/api/realtime/ticket"]);
    expect(memory.get("qm.session")).toBe("1");
  });

  it("wiederkehrend (Merker gesetzt): nur das Ticket – kein POST /api/session je Seitenaufruf", async () => {
    memory.set("qm.session", "1");
    respond({ "/api/realtime/ticket": [json(200, { ticket: "t-2" })] });
    newClient().connect();
    await flush();
    expect(socket().authData).toEqual({ ticket: "t-2", protocolVersion: PROTOCOL_VERSION });
    expect(requestedPaths()).toEqual(["/api/realtime/ticket"]);
  });

  it("veralteter Merker (Cookie weg): Ticket 401 → einmal Session anlegen → Ticket", async () => {
    memory.set("qm.session", "1");
    respond({
      "/api/realtime/ticket": [
        json(401, { error: { code: "UNAUTHORIZED", message: "x" } }),
        json(200, { ticket: "t-3" }),
      ],
      "/api/session": [json(201, { created: true })],
    });
    newClient().connect();
    await flush();
    expect(socket().authData).toEqual({ ticket: "t-3", protocolVersion: PROTOCOL_VERSION });
    expect(requestedPaths()).toEqual(["/api/realtime/ticket", "/api/session", "/api/realtime/ticket"]);
    expect(memory.get("qm.session")).toBe("1");
  });

  it("bleibt das Ticket auch mit neuer Session bei 401 (Cookies blockiert): endgültig UNAUTHORIZED, keine Schleife", async () => {
    respond({
      "/api/session": [json(201, { created: true })],
      "/api/realtime/ticket": [json(401, { error: { code: "UNAUTHORIZED", message: "x" } })],
    });
    const pending = newClient().createLobby("Mia");
    await flush();
    await expect(pending).resolves.toEqual({ ok: false, code: "UNAUTHORIZED" });
    expect(useGameStore.getState().connection.fatal).toBe("UNAUTHORIZED");
    expect(requestedPaths()).toEqual(["/api/session", "/api/realtime/ticket", "/api/session", "/api/realtime/ticket"]);
    expect(memory.has("qm.session")).toBe(false);
  });
});

describe("Ablehnungen erreichen wartende Aktionen", () => {
  it("RATE_LIMITED beim Anlegen der Session: sofort als Ergebnis, Neuversuch nach höchstens 30 s", async () => {
    respond({
      "/api/session": [json(429, { error: { code: "RATE_LIMITED", message: "x", retryAfterMs: 600_000 } })],
    });
    const pending = newClient().createLobby("Mia");
    await flush();
    await expect(pending).resolves.toEqual({ ok: false, code: "RATE_LIMITED" });
    expect(useGameStore.getState().connection.lastError).toBe("RATE_LIMITED");
    expect(socket().connectCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(socket().connectCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket().connectCalls).toBe(2);
  });

  it("Handshake TOO_MANY_CONNECTIONS (connect_error mit data): Code statt NETWORK, Retry-After gedeckelt", async () => {
    memory.set("qm.session", "1");
    respond({ "/api/realtime/ticket": [json(200, { ticket: "t-4" })] });
    const pending = newClient().joinLobby("ABC234", "Mia");
    await flush();
    const rejection = Object.assign(new Error("TOO_MANY_CONNECTIONS"), {
      data: { code: "TOO_MANY_CONNECTIONS", retryAfterMs: 45_000 },
    });
    socket().active = false;
    socket().fire("connect_error", rejection);
    await expect(pending).resolves.toEqual({ ok: false, code: "TOO_MANY_CONNECTIONS" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(socket().connectCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket().connectCalls).toBe(2);
  });

  it("andere Ablehnungen (INTERNAL) melden nach Ablauf der Wartezeit den Code statt NETWORK", async () => {
    respond({
      "/api/session": [json(201, { created: true })],
      "/api/realtime/ticket": [json(500, { error: { code: "INTERNAL", message: "x" } })],
    });
    const pending = newClient().createLobby("Mia");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ ok: false, code: "INTERNAL" });
  });

  it("deckelt Server-Wartezeiten auf 30 s, ohne Angabe gilt der normale Backoff", () => {
    expect(rejectionRetryDelayMs(600_000)).toBe(30_000);
    expect(rejectionRetryDelayMs(1_500)).toBe(1_500);
    expect(rejectionRetryDelayMs(-5)).toBe(0);
    expect(rejectionRetryDelayMs(undefined)).toBeUndefined();
  });
});

describe("Schemawidrige Server-Zustände (kein stilles Einfrieren)", () => {
  async function connectedInLobby(): Promise<FakeSocket> {
    memory.set("qm.session", "1");
    respond({ "/api/realtime/ticket": [json(200, { ticket: "t-5" })] });
    newClient().enterLobby("ABC234");
    await flush();
    socket().accept();
    await flush();
    expect(socket().count("lobby:resume")).toBe(1);
    return socket();
  }

  it("erster ungültiger Zustand → Resync, zweiter in Folge → „Neue Version verfügbar“ (Verbindung beendet)", async () => {
    const fake = await connectedInLobby();
    fake.fire("lobby:state", { ...testLobby({ rev: 2 }), unbekannt: true });
    await flush();
    expect(fake.count("lobby:resume")).toBe(2);
    expect(useGameStore.getState().connection.fatal).toBeNull();
    fake.fire("lobby:state", { ...testLobby({ rev: 3 }), unbekannt: true });
    expect(useGameStore.getState().connection.fatal).toBe("UPDATE_REQUIRED");
    expect(useGameStore.getState().updateRequired).toBe(true);
    expect(fake.connected).toBe(false);
  });

  it("ein gültiger Zustand dazwischen setzt die Zählung zurück; lobby:self wird ebenso geprüft", async () => {
    const fake = await connectedInLobby();
    fake.fire("lobby:state", { ...testLobby({ rev: 2 }), unbekannt: true });
    await flush();
    fake.fire("lobby:state", testLobby({ rev: 3 }));
    fake.fire("lobby:state", { ...testLobby({ rev: 4 }), unbekannt: true });
    await flush();
    expect(useGameStore.getState().connection.fatal).toBeNull();
    expect(useGameStore.getState().lobby?.rev).toBe(3);

    fake.fire("lobby:self", { ...testSelf("p1"), geheim: 1 });
    await flush();
    expect(useGameStore.getState().connection.fatal).toBeNull();
    fake.fire("lobby:self", { ...testSelf("p1"), geheim: 1 });
    expect(useGameStore.getState().connection.fatal).toBe("UPDATE_REQUIRED");
  });

  it("neuere Protokollversion des Servers → sofort „Neue Version verfügbar“", async () => {
    const fake = await connectedInLobby();
    fake.fire("lobby:state", { ...testLobby({ rev: 2 }), protocolVersion: PROTOCOL_VERSION + 1, neu: [] });
    expect(useGameStore.getState().connection.fatal).toBe("UPDATE_REQUIRED");
    expect(fake.count("lobby:resume")).toBe(1);
  });
});

describe("Netzaussetzer (ADR-057)", () => {
  it("verbunden, aber 8 s kein Paket vom Server → „Verbindung hakt“; der nächste Ping hebt es auf", async () => {
    memory.set("qm.session", "1");
    respond({ "/api/realtime/ticket": [json(200, { ticket: "t-9" })] });
    newClient().connect();
    await flush();
    socket().accept();
    await flush();
    expect(useGameStore.getState().stale).toBe(false);
    await vi.advanceTimersByTimeAsync(4_000);
    socket().ping();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(useGameStore.getState().stale).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(useGameStore.getState().stale).toBe(true);
    socket().ping();
    expect(useGameStore.getState().stale).toBe(false);
  });
});
