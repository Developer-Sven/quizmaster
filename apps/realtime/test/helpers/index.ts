/**
 * Test-Harness für Integrationstests von apps/realtime (W2#2 Kern, W2#3 Lobby/Spiel, W4 Watcher).
 *
 * ```ts
 * import { afterAll, beforeAll, expect, it, vi } from "vitest";
 * import { startTestServer, type TestServer } from "../helpers/index.ts";
 *
 * vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
 *
 * let server: TestServer;
 * beforeAll(async () => {
 *   // Eigenen Port-Bereich angeben (oder REALTIME_TEST_PORTS="4140-4149"); Standard ist 4130–4139 (W2#2).
 *   server = await startTestServer({ timing: "fast", devBots: true, ports: { from: 4140, to: 4149 } });
 * });
 * afterAll(() => server?.cleanup());
 *
 * it("Lobby anlegen", async () => {
 *   const alice = await server.connectClient();              // Ticket + eigene simulierte IP automatisch
 *   const state = alice.waitFor("lobby:state", (s) => s.phase === "lobby"); // VOR der Aktion aufrufen
 *   const ack = await alice.emit("lobby:create", { name: "Alice" });       // Ack-Format wird geprüft
 *   expect(ack.ok).toBe(true);
 *   expect((await state).players).toHaveLength(1);
 *   expect(alice.contractViolations).toEqual([]);            // Server-Event-Schemas + keine guestId
 * });
 * ```
 *
 * - `startTestServer(options)`: Test-DB (eigenes Präfix, Indizes, Fixtures aus `test/fixtures/content`
 *   geseedet; `seed: false` spart Zeit), App mit `GAME_TIMING=fast`, `RATE_LIMIT_MODE` (Standard `normal`,
 *   `relaxed` = alle Limits × 100), eigene Secrets, erster freier Port aus `ports`. `env` überschreibt beliebige
 *   Env-Werte (Strings, z. B. `{ MAX_CONNECTIONS: "2" }`), `modules` ersetzt `REALTIME_MODULES`, `clock` die Uhr.
 * - `server.app` (RealtimeApp: `services`, `registry`, `io`), `server.db.repos`/`server.db.collections`,
 *   `server.secrets` (Ticket-/IP-Hash-Secret, METRICS_TOKEN), `server.nextIp()`.
 * - `server.mintTicket(guestId?, opts?)` bzw. `mintTicket(guestId, { secret, … })`: Tickets, auch ungültige
 *   (abgelaufen, falsche Audience, `alg: none`, ohne jti …).
 * - `server.connectClient(opts?)` → `TestClient` (wirft bei `connect_error`); `server.tryConnect(opts?)` liefert
 *   `failure.code` (= `data.code` aus `connect_error`, `null` bei Transport-Ablehnung wie fremder Origin).
 *   Optionen: `guestId`, `ticket` (`null` = ohne), `ticketOptions`, `origin` (`null` = ohne), `ip`,
 *   `headers`, `transports`, `protocolVersion`, `auth` (rohes auth-Objekt).
 * - `TestClient`: `emit(event, payload)`, `waitFor(event, predicate?)`, `received`, `contractViolations`,
 *   `close()`; freie Funktionen `emitWithAck`, `waitFor`, `waitForDisconnect`, `emitRaw`/`emitRawWithAck`
 *   (absichtlich ungültige Nachrichten).
 * - `server.request(path, { headers?, ip?, method? })`: HTTP (`/healthz`, `/metrics`) mit simulierter IP.
 * - `server.cleanup()`: Clients trennen, App stoppen, Test-DB löschen (idempotent).
 * - `createFakeSocket()`, `metricValue()`, `eventually()`: Unit-Tests der Event-Pipeline ohne Netzwerk.
 */
export * from "./client.ts";
export * from "./fakes.ts";
export * from "./fixtures.ts";
export * from "./server.ts";
export * from "./tickets.ts";
