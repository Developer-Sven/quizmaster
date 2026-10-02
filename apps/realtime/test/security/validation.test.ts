/**
 * Invariante 5 (docs/06, docs/11 §Sicherheits-Invarianten 5): Jede Socket-Nachricht wird mit zod validiert –
 * für JEDES registrierte Event des laufenden Servers (Produktions-Handler) systematisch: falsche Typen je Feld,
 * Operator-Objekte, fehlende Pflichtfelder, Zusatzfelder (auch `__proto__`/`constructor`), zu lange Strings,
 * Nicht-Objekte, falsche Argumentzahl → `VALIDATION_FAILED`, kein Handler-Aufruf (keine fachliche Antwort, keine
 * Wirkung), Server stabil. Eine riesige Payload (> 8 KB) trennt der Transport; wiederholt ungültige Nachrichten
 * führen über die Verstöße zur Trennung.
 */
import { CLIENT_EVENT_NAMES, CLIENT_EVENTS, type ClientEventName, parseClientPayload } from "@quizmaster/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  emitRaw,
  emitRawWithAck,
  eventually,
  metricValue,
  type TestClient,
  type TestServer,
  waitForDisconnect,
} from "../helpers/index.ts";
import { startSecurityServer, VALID_PAYLOADS } from "./support.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** Schlüssel eines Event-Payloads (aus dem Schema, ergänzt um die des Beispiels). */
function payloadKeys(event: ClientEventName): string[] {
  const shape = (CLIENT_EVENTS[event].payload as unknown as { shape?: Record<string, unknown> }).shape ?? {};
  return [...new Set([...Object.keys(shape), ...Object.keys(VALID_PAYLOADS[event] as object)])];
}

/** Falsche Werte für ein Feld (Typen, Operatoren, Grenzen, Länge). */
const WRONG_VALUES: readonly unknown[] = [
  123,
  -1,
  1.5,
  0,
  Number.MAX_SAFE_INTEGER + 2,
  true,
  null,
  "",
  "x",
  " ",
  "‮evil",
  [],
  ["x"],
  {},
  { $gt: "" },
  { $where: "1" },
  "x".repeat(7_000),
];

/** Alle ungültigen Varianten eines Events – nur solche, die das gemeinsame Schema selbst ablehnt. */
function invalidVariants(event: ClientEventName): Array<{ label: string; args: unknown[] }> {
  const valid = VALID_PAYLOADS[event] as Record<string, unknown>;
  const candidates: Array<{ label: string; payload: unknown }> = [
    { label: "Zusatzfeld", payload: { ...valid, unexpected: 1 } },
    { label: "constructor", payload: { ...valid, constructor: "x" } },
    {
      label: "__proto__",
      payload: Object.assign(JSON.parse('{"__proto__":{"polluted":true}}') as object, valid),
    },
    { label: "String", payload: "kein Objekt" },
    { label: "Zahl", payload: 42 },
    { label: "null", payload: null },
    { label: "Array", payload: [valid] },
    { label: "true", payload: true },
  ];
  for (const key of payloadKeys(event)) {
    for (const [index, value] of WRONG_VALUES.entries()) {
      candidates.push({ label: `${key}=#${index}`, payload: { ...valid, [key]: value } });
    }
    if (key in valid) {
      const { [key]: _omitted, ...rest } = valid;
      candidates.push({ label: `ohne ${key}`, payload: rest });
    }
  }
  const variants = candidates
    .filter((candidate) => !parseClientPayload(event, candidate.payload).success)
    .map((candidate) => ({ label: candidate.label, args: [candidate.payload] }));
  variants.push({ label: "kein Argument", args: [] });
  variants.push({ label: "zwei Argumente", args: [valid, valid] });
  return variants;
}

describe("Invariante 5 – jedes registrierte Event (Produktions-Handler)", () => {
  let server: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    // relaxed (×100): Hunderte absichtlicher Verstöße hintereinander, ohne dass der Socket getrennt wird.
    server = await startSecurityServer({ devBots: true, rateLimits: "relaxed" });
    client = await server.connectClient();
  });
  afterAll(() => server?.cleanup());

  it("die Registry enthält genau die Events aus CLIENT_EVENTS", () => {
    expect(new Set(server.app.registry.registeredEvents())).toEqual(new Set(CLIENT_EVENT_NAMES));
  });

  for (const event of CLIENT_EVENT_NAMES) {
    it(`${event}: ungültige Payloads → VALIDATION_FAILED, Handler nie erreicht`, async () => {
      const variants = invalidVariants(event);
      expect(variants.length).toBeGreaterThan(8);
      // Eigener Socket je Event: Verstöße zählen je Socket (`socket.violations`, gelockert × 100). Über alle Events auf
      // einem Socket summiert, trennte der Server – je mehr Einstellungsfelder, desto früher – zu Recht.
      const eventClient = await server.connectClient();
      try {
        const metrics = server.app.services.metrics;
        const failuresBefore = await metricValue(metrics, "qm_validation_failures_total", { event });
        const lobbiesBefore = await server.db.collections.lobbies.countDocuments({});
        for (const variant of variants) {
          const ack = await emitRawWithAck(eventClient.socket, event, variant.args);
          expect(ack, `${event} (${variant.label})`).toMatchObject({
            ok: false,
            error: { code: "VALIDATION_FAILED" },
          });
          // Die Meldung nennt nur Pfad und Fehlerart, nie die Eingabe.
          const message = (ack as { error: { message: string } }).error.message;
          expect(message.length).toBeLessThan(400);
          expect(message.includes("xxxxxxxxxx")).toBe(false);
        }
        expect(await metricValue(metrics, "qm_validation_failures_total", { event })).toBe(
          failuresBefore + variants.length,
        );
        // Keine Wirkung: kein Handler lief (sonst entstünde z. B. eine Lobby oder eine fachliche Antwort).
        expect(await server.db.collections.lobbies.countDocuments({})).toBe(lobbiesBefore);
        expect(eventClient.socket.connected).toBe(true);
        expect(eventClient.contractViolations).toEqual([]);
      } finally {
        eventClient.close();
      }
    });
  }

  it("Prototype Pollution bleibt wirkungslos; der Server bleibt stabil", async () => {
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(client.contractViolations).toEqual([]);
    expect((await server.request("/healthz")).status).toBe(200);
    const fresh = await server.connectClient();
    expect((await fresh.emit("lobby:create", { name: "Ben" })).ok).toBe(true);
    fresh.close();
  });

  it("Event ohne Ack-Callback: keine Antwort, aber als Verstoß gezählt", async () => {
    const metrics = server.app.services.metrics;
    const before = await metricValue(metrics, "qm_violations_total", { reason: "missing_ack" });
    emitRaw(client.socket, "time:sync", { t0: 1 });
    await eventually(
      async () => (await metricValue(metrics, "qm_violations_total", { reason: "missing_ack" })) > before,
    );
  });
});

describe("Riesige Payloads und wiederholte Verstöße (normale Limits)", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startSecurityServer({ seed: false });
  });
  afterAll(() => server?.cleanup());

  it("Payload über 8 KB → Transport trennt nur diesen Socket; knapp darunter → VALIDATION_FAILED", async () => {
    const victim = await server.connectClient();
    const bystander = await server.connectClient();
    expect(await emitRawWithAck(victim.socket, "lobby:create", [{ name: "x".repeat(7_500) }])).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    const gone = waitForDisconnect(victim.socket);
    emitRaw(victim.socket, "lobby:create", { name: "x".repeat(20_000) }, () => undefined);
    expect(["transport close", "transport error"]).toContain(await gone);
    const longPolling = await server.connectClient({ transports: ["polling"] });
    const pollingGone = waitForDisconnect(longPolling.socket, 10_000);
    emitRaw(longPolling.socket, "time:sync", { t0: 1, pad: "y".repeat(50_000) }, () => undefined);
    expect(["transport close", "transport error", "ping timeout"]).toContain(await pollingGone);
    expect((await bystander.emit("time:sync", { t0: 1 })).ok).toBe(true);
    expect((await server.request("/healthz")).status).toBe(200);
    bystander.close();
  });

  it("11 ungültige Nachrichten in einer Minute → Socket getrennt (Verstöße), Server stabil", async () => {
    const offender = await server.connectClient();
    const gone = waitForDisconnect(offender.socket);
    for (let i = 0; i < 11; i++) {
      expect(await emitRawWithAck(offender.socket, "lobby:join", [{ code: i, name: null }])).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_FAILED" },
      });
    }
    expect(await gone).toBe("io server disconnect");
    const next = await server.connectClient();
    expect((await next.emit("time:sync", { t0: 1 })).ok).toBe(true);
    next.close();
  });
});
