/**
 * Turnstile im Realtime-Client (docs/06 §Bot-Schutz) gegen einen nachgebauten Socket (socket.io-client gemockt)
 * und gemocktes `fetch`: Session mit Token (vorab gelöst bzw. nach TURNSTILE_REQUIRED), Notfall-Schalter
 * `turnstileOnJoin` (TURNSTILE_REQUIRED → lösen → Ticket mit `turnstileToken` → neu verbinden → Aktion genau einmal
 * wiederholen), keine Endlosschleife bei gescheiterter Prüfung, `lobby:resume` ohne Turnstile.
 */
import { PROTOCOL_VERSION } from "@quizmaster/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gameActions, useGameStore } from "../../stores/game-store";
import { getRealtimeClient, type RealtimeClient, type TurnstilePurpose } from "./realtime-client";
import { resetSessionForTests } from "./session";

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
/** Pfad und JSON-Body je Request. */
const requests = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    path: String(url),
    body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
  }));

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
  client = getRealtimeClient({ realtimeUrl: `http://rt-turnstile-${urlCounter}.test` });
  return client;
}

/** Turnstile-Anbieter mit Protokoll; liefert die Tokens der Reihe nach (`null` = gescheitert). */
function provider(tokens: Array<string | null>) {
  const calls: TurnstilePurpose[] = [];
  const queue = [...tokens];
  const fn = vi.fn(async (purpose: TurnstilePurpose) => {
    calls.push(purpose);
    return queue.length > 0 ? (queue.shift() ?? null) : null;
  });
  return { fn, calls };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const ERROR = (code: string) => ({ error: { code, message: "x" } });

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

describe("Turnstile für neue Sessions", () => {
  it("TURNSTILE_ENABLED: Token vor POST /api/session lösen – eine Anfrage, ohne Ablehnung", async () => {
    respond({ "/api/session": [json(201, { created: true })], "/api/realtime/ticket": [json(200, { ticket: "t-1" })] });
    const turnstile = provider(["tok-session"]);
    const realtime = newClient();
    realtime.setTurnstileProvider(turnstile.fn, { sessionRequiresToken: true });
    realtime.connect();
    await flush();
    expect(turnstile.calls).toEqual(["session"]);
    expect(requests()).toEqual([
      { path: "/api/session", body: { turnstileToken: "tok-session" } },
      { path: "/api/realtime/ticket", body: {} },
    ]);
    expect(socket().authData).toEqual({ ticket: "t-1", protocolVersion: PROTOCOL_VERSION });
  });

  it("ohne Vorab-Prüfung: 403 TURNSTILE_REQUIRED → einmal lösen → Session mit Token → Ticket", async () => {
    respond({
      "/api/session": [json(403, ERROR("TURNSTILE_REQUIRED")), json(201, { created: true })],
      "/api/realtime/ticket": [json(200, { ticket: "t-2" })],
    });
    const turnstile = provider(["tok-2"]);
    const realtime = newClient();
    realtime.setTurnstileProvider(turnstile.fn);
    realtime.connect();
    await flush();
    expect(turnstile.calls).toEqual(["session"]);
    expect(requests().map((request) => request.body)).toEqual([{}, { turnstileToken: "tok-2" }, {}]);
    expect(socket().authData).toEqual({ ticket: "t-2", protocolVersion: PROTOCOL_VERSION });
  });

  it("verworfenes Token (403 trotz Token) → einmal frisch lösen", async () => {
    respond({
      "/api/session": [json(403, ERROR("TURNSTILE_REQUIRED")), json(201, { created: true })],
      "/api/realtime/ticket": [json(200, { ticket: "t-3" })],
    });
    const turnstile = provider(["alt", "frisch"]);
    const realtime = newClient();
    realtime.setTurnstileProvider(turnstile.fn, { sessionRequiresToken: true });
    realtime.connect();
    await flush();
    expect(turnstile.calls).toEqual(["session", "session"]);
    expect(requests().map((request) => request.body.turnstileToken)).toEqual(["alt", "frisch", undefined]);
  });

  it("gescheiterte Prüfung → TURNSTILE_REQUIRED für die Aktion, KEIN automatischer Neuversuch, nicht endgültig gesperrt", async () => {
    respond({ "/api/session": [json(201, { created: true })], "/api/realtime/ticket": [json(200, { ticket: "t-4" })] });
    const turnstile = provider([null, "tok-ok"]);
    const realtime = newClient();
    realtime.setTurnstileProvider(turnstile.fn, { sessionRequiresToken: true });
    const pending = realtime.createLobby("Mia");
    await flush();
    await expect(pending).resolves.toEqual({ ok: false, code: "TURNSTILE_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket().connectCalls).toBe(1);
    expect(turnstile.calls).toEqual(["session"]);
    expect(useGameStore.getState().connection.fatal).toBeNull();

    // Nächster Klick: neue Prüfung, diesmal erfolgreich.
    socket().responder = (event) =>
      event === "lobby:create" ? { ok: true, data: { code: "ABC234" } } : { ok: true, data: { serverNow: 1 } };
    const again = realtime.createLobby("Mia");
    await flush();
    expect(socket().connectCalls).toBe(2);
    socket().accept();
    await expect(again).resolves.toEqual({ ok: true, data: { code: "ABC234" } });
    expect(turnstile.calls).toEqual(["session", "session"]);
  });

  it("eine Bestätigung darf länger dauern als die Verbindungs-Wartezeit (10 s) – die Aktion wartet", async () => {
    respond({ "/api/session": [json(201, { created: true })], "/api/realtime/ticket": [json(200, { ticket: "t-5" })] });
    let release: (token: string) => void = () => undefined;
    const slow = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
    );
    const realtime = newClient();
    realtime.setTurnstileProvider(slow, { sessionRequiresToken: true });
    socket().responder = (event) =>
      event === "lobby:create" ? { ok: true, data: { code: "ABC234" } } : { ok: true, data: { serverNow: 1 } };
    const pending = realtime.createLobby("Mia");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(settled).toBe(false);
    release("tok-spät");
    await flush();
    socket().accept();
    await expect(pending).resolves.toEqual({ ok: true, data: { code: "ABC234" } });
  });

  it("ohne Anbieter (kein Site Key) bleibt TURNSTILE_REQUIRED endgültig", async () => {
    respond({ "/api/session": [json(403, ERROR("TURNSTILE_REQUIRED"))] });
    const pending = newClient().createLobby("Mia");
    await flush();
    await expect(pending).resolves.toEqual({ ok: false, code: "TURNSTILE_REQUIRED" });
    expect(useGameStore.getState().connection.fatal).toBe("TURNSTILE_REQUIRED");
  });
});

describe("Notfall-Schalter turnstileOnJoin", () => {
  /** Verbundener Client mit Session-Merker (kein POST /api/session nötig). */
  async function connected(tokens: Array<string | null>, tickets: Response[]) {
    memory.set("qm.session", "1");
    respond({ "/api/realtime/ticket": tickets });
    const turnstile = provider(tokens);
    const realtime = newClient();
    realtime.setTurnstileProvider(turnstile.fn, { sessionRequiresToken: false });
    realtime.connect();
    await flush();
    socket().accept();
    await flush();
    return { realtime, turnstile };
  }

  it("create → TURNSTILE_REQUIRED → lösen → Ticket mit turnstileToken → neu verbinden → genau ein zweiter Versuch", async () => {
    const { realtime, turnstile } = await connected(
      ["tok-join"],
      [json(200, { ticket: "t-plain" }), json(200, { ticket: "t-tsv" })],
    );
    let creates = 0;
    socket().responder = (event) => {
      if (event !== "lobby:create") return { ok: true, data: { serverNow: 1 } };
      creates += 1;
      return creates === 1
        ? { ok: false, error: { code: "TURNSTILE_REQUIRED", message: "x" } }
        : { ok: true, data: { code: "ABC234" } };
    };
    const pending = realtime.createLobby("Mia");
    await flush();
    expect(turnstile.calls).toEqual(["join"]);
    // Neu verbunden mit dem Ticket aus dem Token-Request.
    expect(requests().map((request) => request.body)).toEqual([{}, { turnstileToken: "tok-join" }]);
    expect(socket().authData).toEqual({ ticket: "t-tsv", protocolVersion: PROTOCOL_VERSION });
    socket().accept();
    await expect(pending).resolves.toEqual({ ok: true, data: { code: "ABC234" } });
    expect(creates).toBe(2);
    expect(useGameStore.getState().code).toBe("ABC234");
  });

  it("join: erneut TURNSTILE_REQUIRED nach dem zweiten Versuch → Fehler (kein dritter Versuch)", async () => {
    const { realtime, turnstile } = await connected(
      ["tok-1", "tok-2"],
      [json(200, { ticket: "t-a" }), json(200, { ticket: "t-b" })],
    );
    socket().responder = (event) =>
      event === "lobby:join"
        ? { ok: false, error: { code: "TURNSTILE_REQUIRED", message: "x" } }
        : { ok: true, data: { serverNow: 1 } };
    const pending = realtime.joinLobby("ABC234", "Ben");
    await flush();
    socket().accept();
    await expect(pending).resolves.toEqual({ ok: false, code: "TURNSTILE_REQUIRED" });
    expect(socket().count("lobby:join")).toBe(2);
    expect(turnstile.calls).toEqual(["join"]);
  });

  it("Prüfung scheitert → die Aktion endet mit TURNSTILE_REQUIRED, ohne neu zu verbinden", async () => {
    const { realtime } = await connected([null], [json(200, { ticket: "t-a" })]);
    socket().responder = () => ({ ok: false, error: { code: "TURNSTILE_REQUIRED", message: "x" } });
    const pending = realtime.joinLobby("ABC234", "Ben");
    await flush();
    await expect(pending).resolves.toEqual({ ok: false, code: "TURNSTILE_REQUIRED" });
    expect(socket().connectCalls).toBe(1);
    expect(socket().connected).toBe(true);
  });

  it("Web lehnt das Token ab (403) → einmal frisch lösen und das Ticket damit holen", async () => {
    const { realtime, turnstile } = await connected(
      ["tok-alt", "tok-neu"],
      [json(200, { ticket: "t-a" }), json(403, ERROR("TURNSTILE_REQUIRED")), json(200, { ticket: "t-c" })],
    );
    let creates = 0;
    socket().responder = (event) => {
      if (event !== "lobby:create") return { ok: true, data: { serverNow: 1 } };
      creates += 1;
      return creates === 1
        ? { ok: false, error: { code: "TURNSTILE_REQUIRED", message: "x" } }
        : { ok: true, data: { code: "XYZ789" } };
    };
    const pending = realtime.createLobby("Mia");
    await flush();
    expect(turnstile.calls).toEqual(["join", "join"]);
    expect(requests().map((request) => request.body.turnstileToken)).toEqual([undefined, "tok-alt", "tok-neu"]);
    socket().accept();
    await expect(pending).resolves.toEqual({ ok: true, data: { code: "XYZ789" } });
  });

  it("lobby:resume braucht nie Turnstile (Reconnect in der Lobby ohne Prüfung)", async () => {
    memory.set("qm.session", "1");
    respond({ "/api/realtime/ticket": [json(200, { ticket: "t-r" })] });
    const turnstile = provider(["nie"]);
    const realtime = newClient();
    realtime.setTurnstileProvider(turnstile.fn);
    realtime.enterLobby("ABC234");
    await flush();
    socket().accept();
    await flush();
    expect(socket().count("lobby:resume")).toBe(1);
    expect(turnstile.calls).toEqual([]);
    expect(requests().every((request) => request.body.turnstileToken === undefined)).toBe(true);
  });
});
