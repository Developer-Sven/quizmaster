/**
 * Handshake (docs/05 §Verbindung 3, docs/06 §Identität/§DDoS, ADR-028) gegen einen echten Server:
 * Origin, Ticket (Signatur, Claims, Ablauf, jti einmalig), Bans (Gast + IP), Protokollversion,
 * Verbindungs- und Handshake-Limits, Lastabwurf.
 */
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION } from "@quizmaster/shared";
import { ipKey } from "@quizmaster/shared/ip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { roomForGuest } from "../../src/registry/rooms.ts";
import {
  type ConnectFailure,
  eventually,
  metricValue,
  startTestServer,
  type TestConnectOptions,
  type TestServer,
} from "../helpers/index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({ seed: false });
});
afterAll(() => server?.cleanup());

async function expectRejected(options: TestConnectOptions = {}): Promise<ConnectFailure> {
  const result = await server.tryConnect(options);
  if (result.ok) {
    result.client.close();
    throw new Error("Verbindung wurde unerwartet angenommen");
  }
  return result.failure;
}

/** Roher Engine.IO-Handshake per Long-Polling (ohne Socket.IO-Client). */
async function pollingHandshake(headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const response = await server.request("/socket.io/?EIO=4&transport=polling", { headers });
  return { status: response.status, body: await response.text() };
}

describe("Origin (allowRequest, ADR-028)", () => {
  it("lässt APP_ORIGIN zu (auch in anderer Schreibweise)", async () => {
    expect((await pollingHandshake({ origin: server.origin })).status).toBe(200);
    expect((await pollingHandshake({ origin: "HTTP://LOCALHOST:3000" })).status).toBe(200);
  });

  it("lehnt fremde, ungültige und fehlende Origins vor der Engine-Sitzung ab", async () => {
    const before = await metricValue(server.app.services.metrics, "qm_connections_rejected_total", {
      reason: "origin",
    });
    const variants: Array<Record<string, string>> = [
      { origin: "http://evil.example" },
      { origin: "http://localhost:3001" },
      { origin: "null" },
      {},
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
    ];
    for (const headers of variants) {
      const result = await pollingHandshake(headers);
      expect(result.status, JSON.stringify(headers)).toBe(403);
      expect(result.body).not.toContain('"sid"');
    }
    expect(await metricValue(server.app.services.metrics, "qm_connections_rejected_total", { reason: "origin" })).toBe(
      before + 6,
    );
  });

  it("ADR-028: fehlender Origin nur mit Sec-Fetch-Site: same-origin", async () => {
    const handshake = await pollingHandshake({ "sec-fetch-site": "same-origin" });
    expect(handshake.status).toBe(200);
    expect(handshake.body).toContain('"sid"');

    const client = await server.connectClient({
      origin: null,
      headers: { "sec-fetch-site": "same-origin" },
      transports: ["polling"],
    });
    expect((await client.emit("time:sync", { t0: 1 })).ok).toBe(true);
    client.close();

    const failure = await expectRejected({ origin: null, transports: ["polling"] });
    expect(failure.code).toBeNull();
  });

  it("WebSocket-Upgrade mit fremder Origin wird abgelehnt (Transportfehler, kein Code)", async () => {
    expect((await expectRejected({ origin: "https://evil.example" })).code).toBeNull();
    expect((await expectRejected({ origin: null })).code).toBeNull();
  });
});

describe("Ticket", () => {
  it("gültiges Ticket → verbunden, im Gast-Raum, socket.data gesetzt", async () => {
    const guestId = randomUUID();
    const ticket = await server.mintTicket(guestId, { tsv: 1_234 });
    const client = await server.connectClient({ guestId, ticket });
    const sockets = await server.app.io.in(roomForGuest(guestId)).fetchSockets();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.data).toEqual({
      guestId,
      ipKey: ipKey(client.ip, server.secrets.ipHash),
      ticketTsv: 1_234,
    });
    expect(server.app.services.connections.countForGuest(guestId)).toBe(1);
    client.close();
    await eventually(() => server.app.services.connections.countForGuest(guestId) === 0);
  });

  it("ungültige Tickets → UNAUTHORIZED", async () => {
    const guestId = randomUUID();
    const cases: Array<[string, Promise<string | null> | string | null]> = [
      ["kein Ticket", null],
      ["Unsinn", "abc"],
      ["leer", ""],
      ["falsches Secret", server.mintTicket(guestId, { secret: "x".repeat(40) })],
      ["abgelaufen", server.mintTicket(guestId, { expiresInSec: -120 })],
      ["falsche Audience", server.mintTicket(guestId, { audience: "web" })],
      ["falscher Issuer", server.mintTicket(guestId, { issuer: "evil" })],
      ["alg none", server.mintTicket(guestId, { algorithm: "none" })],
      ["HS512", server.mintTicket(guestId, { algorithm: "HS512" })],
      ["ohne jti", server.mintTicket(guestId, { omit: ["jti"] })],
      ["ohne exp", server.mintTicket(guestId, { omit: ["exp"] })],
      ["sub keine UUID", server.mintTicket("keine-uuid")],
      ["exp weit in der Zukunft", server.mintTicket(guestId, { expiresInSec: 3_600 })],
      ["iat in der Zukunft", server.mintTicket(guestId, { nowMs: Date.now() + 120_000 })],
      ["zu langes Ticket", "a".repeat(3_000)],
    ];
    for (const [label, ticket] of cases) {
      const failure = await expectRejected({ guestId, ticket: await ticket });
      expect(failure.code, label).toBe("UNAUTHORIZED");
    }
  });

  it("auth-Payload wird strikt geprüft (Zusatzfelder, fehlende Protokollversion)", async () => {
    const ticket = await server.mintTicket();
    expect((await expectRejected({ auth: { ticket, protocolVersion: PROTOCOL_VERSION, extra: true } })).code).toBe(
      "UNAUTHORIZED",
    );
    expect((await expectRejected({ ticket: await server.mintTicket(), protocolVersion: null })).code).toBe(
      "UNAUTHORIZED",
    );
  });

  it("jedes Ticket (jti) gilt nur einmal", async () => {
    const guestId = randomUUID();
    const ticket = await server.mintTicket(guestId);
    const client = await server.connectClient({ guestId, ticket });
    expect((await expectRejected({ guestId, ticket })).code).toBe("UNAUTHORIZED");
    client.close();
    // Auch nach dem Trennen bleibt das Ticket verbraucht.
    expect((await expectRejected({ guestId, ticket })).code).toBe("UNAUTHORIZED");
  });
});

describe("Bans", () => {
  it("gesperrter Gast → BANNED; abgelaufene Sperre zählt nicht", async () => {
    const guestId = randomUUID();
    const bans = server.db.repos.bans;
    await bans.upsert(
      { kind: "guest", value: guestId, reason: "test", expiresAt: new Date(Date.now() + 60_000) },
      new Date(),
    );
    expect((await expectRejected({ guestId })).code).toBe("BANNED");

    const expired = randomUUID();
    await bans.upsert(
      { kind: "guest", value: expired, reason: "test", expiresAt: new Date(Date.now() - 1_000) },
      new Date(),
    );
    const client = await server.connectClient({ guestId: expired });
    client.close();
  });

  it("gesperrter IP-Schlüssel → BANNED (auch für andere Gäste dieser IP)", async () => {
    const ip = server.nextIp();
    const key = ipKey(ip, server.secrets.ipHash);
    if (key === null) throw new Error("IP-Schlüssel fehlt");
    await server.db.repos.bans.upsert({ kind: "ip", value: key, reason: "test" }, new Date());
    expect((await expectRejected({ ip })).code).toBe("BANNED");
    expect((await expectRejected({ ip })).code).toBe("BANNED");
    const other = await server.connectClient({ ip: server.nextIp() });
    other.close();
  });
});

describe("Protokollversion", () => {
  it("protocolVersion < appConfig.minClientProtocol → UPDATE_REQUIRED", async () => {
    const appConfig = server.app.services.appConfig;
    const original = appConfig.get();
    appConfig.apply({ ...original, minClientProtocol: PROTOCOL_VERSION + 1 });
    try {
      expect((await expectRejected()).code).toBe("UPDATE_REQUIRED");
      const newer = await server.connectClient({ protocolVersion: PROTOCOL_VERSION + 1 });
      newer.close();
    } finally {
      appConfig.apply(original);
    }
    const current = await server.connectClient();
    current.close();
  });
});

describe("Verbindungsgrenzen", () => {
  it("höchstens 5 gleichzeitige Sockets je Gast (nach der Auth) → TOO_MANY_CONNECTIONS", async () => {
    const guestId = randomUUID();
    const clients = [];
    for (let i = 0; i < 5; i++) clients.push(await server.connectClient({ guestId }));
    const failure = await expectRejected({ guestId });
    expect(failure.code).toBe("TOO_MANY_CONNECTIONS");
    expect(
      await metricValue(server.app.services.metrics, "qm_rate_limit_hits_total", { rule: "connections.guest" }),
    ).toBeGreaterThanOrEqual(1);

    clients[0]?.close();
    await eventually(() => server.app.services.connections.countForGuest(guestId) === 4);
    clients.push(await server.connectClient({ guestId }));
    for (const client of clients) client.close();
    await eventually(() => server.app.services.connections.countForGuest(guestId) === 0);
  });

  it("Handshake-Limit 60/min je IP → RATE_LIMITED mit retryAfterMs; ab dem Doppelten harte Ablehnung", async () => {
    const ip = server.nextIp();
    for (let i = 0; i < 60; i++) {
      expect((await expectRejected({ ip, ticket: "kein-ticket" })).code).toBe("UNAUTHORIZED");
    }
    const limited = await expectRejected({ ip });
    expect(limited.code).toBe("RATE_LIMITED");
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    expect(limited.retryAfterMs).toBeLessThanOrEqual(60_000);
    for (let i = 62; i <= 120; i++) expect((await expectRejected({ ip })).code).toBe("RATE_LIMITED");
    const flood = await expectRejected({ ip });
    expect(flood.code).toBeNull();
    expect(await metricValue(server.app.services.metrics, "qm_connections_rejected_total", { reason: "flood" })).toBe(
      1,
    );
    // Andere IPs sind nicht betroffen.
    const other = await server.connectClient();
    other.close();
  });

  it("Lastabwurf: Event-Loop-Verzögerung p99 > 200 ms in zwei Fenstern → SERVER_BUSY für neue Verbindungen", async () => {
    const eventLoop = server.app.services.metrics.eventLoop;
    const block = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        // absichtlich blockieren
      }
    };
    const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
    await tick();
    eventLoop.sample();
    for (let window = 0; window < 2; window++) {
      // Nach dem Zurücksetzen braucht der Monitor einen Tick als Bezugspunkt.
      await tick();
      block(300);
      await tick();
      eventLoop.sample();
    }
    expect(eventLoop.p99Ms()).toBeGreaterThan(200);
    expect(eventLoop.overloaded()).toBe(true);
    expect((await expectRejected()).code).toBe("SERVER_BUSY");
    expect(server.app.services.admission.lobbyCreation(0)).toBe("SERVER_BUSY");

    await new Promise((resolve) => setTimeout(resolve, 60));
    eventLoop.sample();
    expect(eventLoop.overloaded()).toBe(false);
    expect(server.app.services.admission.lobbyCreation(0)).toBeNull();
    const client = await server.connectClient();
    client.close();
  });
});

describe("globale Grenze MAX_CONNECTIONS", () => {
  let small: TestServer;

  beforeAll(async () => {
    small = await startTestServer({ seed: false, env: { MAX_CONNECTIONS: "2" } });
  });
  afterAll(() => small?.cleanup());

  it("darüber → SERVER_BUSY", async () => {
    const first = await small.connectClient();
    const second = await small.connectClient();
    const result = await small.tryConnect();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("SERVER_BUSY");
    expect(small.app.services.connections.total()).toBe(2);
    first.close();
    await eventually(() => small.app.services.connections.total() === 1);
    const third = await small.connectClient();
    second.close();
    third.close();
  });
});

describe("Kill-Switches für neue Lobbys", () => {
  it("admission.lobbyCreation liest appConfig live", () => {
    const { appConfig, admission } = server.app.services;
    const original = appConfig.get();
    try {
      expect(admission.lobbyCreation(0)).toBeNull();
      appConfig.apply({ ...original, lobbyCreationEnabled: false });
      expect(admission.lobbyCreation(0)).toBe("LOBBY_CREATION_DISABLED");
      appConfig.apply({ ...original, maxActiveLobbies: 3 });
      expect(admission.lobbyCreation(2)).toBeNull();
      expect(admission.lobbyCreation(3)).toBe("SERVER_BUSY");
    } finally {
      appConfig.apply(original);
    }
  });
});
