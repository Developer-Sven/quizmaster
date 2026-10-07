/**
 * `startTestServer()` – Realtime-App in-process gegen die Test-Datenbank (`@quizmaster/db/testing`, eigenes
 * Collection-Präfix, Fixtures geseedet) auf einem freien Port aus dem Port-Bereich des Aufrufers.
 *
 * Simulierte Client-IPs: Der Test-Server vertraut dem Header `x-qm-test-ip` (`TRUSTED_IP_HEADER`, wie in
 * Produktion `cf-connecting-ip`). Jeder Test-Client bekommt standardmäßig eine eigene IP – IP-Limits
 * (Handshakes 60/min, 100 Verbindungen) greifen so realistisch je Client statt für alle Tests gemeinsam.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createRepositories, seedCatalog } from "@quizmaster/db";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import type { GameTimingMode } from "@quizmaster/shared";
import pino from "pino";
import { createRealtimeApp, type RealtimeApp } from "../../src/app.ts";
import { parseRealtimeEnv, type RateLimitMode, type RealtimeEnv, type RealtimeEnvInput } from "../../src/env.ts";
import { createLogger, type LogLevel } from "../../src/logger.ts";
import type { Clock, RealtimeDb, RealtimeModule } from "../../src/registry/types.ts";
import { type ConnectFailure, type ConnectOptions, createTestClient, type TestClient, tryConnect } from "./client.ts";
import { loadFixtureCatalog } from "./fixtures.ts";
import { type MintTicketOptions, mintTicket } from "./tickets.ts";

/** Origin, die der Test-Server erlaubt (APP_ORIGIN). */
export const TEST_ORIGIN = "http://localhost:3000";
/** Vertrauenswürdiger IP-Header des Test-Servers. */
export const TEST_IP_HEADER = "x-qm-test-ip";
/** Port-Bereich der Kern-Suite (apps/realtime/test/core); andere Suiten übergeben ihren eigenen. */
export const DEFAULT_TEST_PORTS = { from: 4130, to: 4139 } as const;

export interface PortRange {
  from: number;
  to: number;
}

export interface StartTestServerOptions {
  /** `GAME_TIMING` (Standard `fast`). */
  timing?: GameTimingMode;
  /** `DEV_BOTS_ENABLED` (Standard false). */
  devBots?: boolean;
  /** `RATE_LIMIT_MODE` (Standard `normal`; `relaxed` = alle Limits × 100). */
  rateLimits?: RateLimitMode;
  /** Weitere Env-Werte als Strings (überschreiben alles andere, z. B. `MAX_CONNECTIONS`). */
  env?: RealtimeEnvInput;
  /** Fixtures aus `test/fixtures/content` seeden (Standard true). */
  seed?: boolean;
  /** Module (Standard: `REALTIME_MODULES` der App). */
  modules?: readonly RealtimeModule[];
  /** Ports zum Lauschen: Bereich oder Liste; Standard `REALTIME_TEST_PORTS` („4130-4139“) bzw. 4130–4139. */
  ports?: PortRange | readonly number[];
  clock?: Clock;
  /** Log-Level (Standard `QM_TEST_LOG_LEVEL` oder `silent`); Ausgabe nach stderr. */
  logLevel?: LogLevel;
  /** Bestehende Test-DB wiederverwenden (wird dann von `cleanup()` NICHT gelöscht). */
  database?: TestDatabase;
}

export interface TestConnectOptions extends Partial<Omit<ConnectOptions, "url">> {
  /** guestId für ein automatisch erzeugtes Ticket (Standard: zufällig). */
  guestId?: string;
  /** Optionen für das automatisch erzeugte Ticket. */
  ticketOptions?: MintTicketOptions;
  /** Simulierte Client-IP (Standard: eindeutig je Client); `null` = ohne IP-Header. */
  ip?: string | null;
}

export interface TestServer {
  readonly app: RealtimeApp;
  readonly env: RealtimeEnv;
  readonly database: TestDatabase;
  readonly db: RealtimeDb;
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  readonly port: number;
  readonly origin: string;
  readonly secrets: { readonly ticket: string; readonly ipHash: string; readonly metricsToken: string };
  /** Ticket mit dem Secret dieses Servers (Optionen für gezielt ungültige Tickets). */
  mintTicket(guestId?: string, options?: MintTicketOptions): Promise<string>;
  /** Verbindet einen Client (Ticket und IP automatisch, falls nicht angegeben); wirft bei `connect_error`. */
  connectClient(options?: TestConnectOptions): Promise<TestClient>;
  /** Wie `connectClient`, liefert aber den Fehler statt zu werfen. */
  tryConnect(
    options?: TestConnectOptions,
  ): Promise<{ ok: true; client: TestClient } | { ok: false; failure: ConnectFailure }>;
  /** HTTP-Anfrage an den Server (simulierte IP über den Test-Header). */
  request(
    path: string,
    init?: { headers?: Record<string, string>; ip?: string | null; method?: string },
  ): Promise<Response>;
  /** Neue eindeutige simulierte Client-IP. */
  nextIp(): string;
  /** Trennt alle Clients, stoppt die App und löscht die Test-DB (falls selbst angelegt). Idempotent. */
  cleanup(): Promise<void>;
}

let ipCounter = Math.floor(Math.random() * 0xffff) * 0x100;

/** Eindeutige IPv4 aus 10.0.0.0/8 je Aufruf. */
export function nextTestIp(): string {
  ipCounter = (ipCounter + 1) % 0xffffff;
  const n = ipCounter + 1;
  return `10.${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}`;
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function parsePortRange(value: string | undefined): PortRange {
  const match = /^(\d{4,5})-(\d{4,5})$/.exec(value?.trim() ?? "");
  if (!match) return { ...DEFAULT_TEST_PORTS };
  return { from: Number(match[1]), to: Number(match[2]) };
}

function portCandidates(ports: PortRange | readonly number[] | undefined): number[] {
  if (ports !== undefined && !("from" in ports)) return [...ports];
  const range = ports ?? parsePortRange(process.env.REALTIME_TEST_PORTS);
  const list: number[] = [];
  for (let port = range.from; port <= range.to; port++) list.push(port);
  return list;
}

export async function startTestServer(options: StartTestServerOptions = {}): Promise<TestServer> {
  const ownsDatabase = options.database === undefined;
  const database = options.database ?? (await createTestDatabase({ ensureIndexes: true }));
  const clients = new Set<TestClient>();
  let app: RealtimeApp | undefined;
  try {
    if (options.seed !== false) {
      await seedCatalog(database.db, loadFixtureCatalog(), { prefix: database.prefix, pool: "all" });
    }
    const candidates = portCandidates(options.ports);
    const secrets = { ticket: randomSecret(), ipHash: randomSecret(), metricsToken: randomSecret() };
    const input: Record<string, string> = {
      HOST: "127.0.0.1",
      REALTIME_PORT: String(candidates[0] ?? DEFAULT_TEST_PORTS.from),
      APP_ORIGIN: TEST_ORIGIN,
      MONGODB_URI: database.uri,
      MONGODB_DB: database.dbName,
      MONGODB_COLLECTION_PREFIX: database.prefix,
      REALTIME_TICKET_SECRET: secrets.ticket,
      IP_HASH_SECRET: secrets.ipHash,
      METRICS_TOKEN: secrets.metricsToken,
      TRUSTED_IP_HEADER: TEST_IP_HEADER,
      GAME_TIMING: options.timing ?? "fast",
      QUESTION_POOL: "all",
      DEV_BOTS_ENABLED: String(options.devBots ?? false),
      RATE_LIMIT_MODE: options.rateLimits ?? "normal",
      LOG_LEVEL: options.logLevel ?? process.env.QM_TEST_LOG_LEVEL ?? "silent",
    };
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (value !== undefined) input[key] = value;
    }
    const parsed = parseRealtimeEnv(input);
    if (!parsed.ok) throw new Error(`Test-Env ungültig: ${parsed.problems.join("; ")}`);
    const env = parsed.env;
    const logger = createLogger({ level: env.LOG_LEVEL, destination: pino.destination({ dest: 2, sync: true }) });
    const db: RealtimeDb = {
      client: database.client,
      db: database.db,
      collections: database.collections,
      repos: createRepositories(database.client, database.collections),
      prefix: database.prefix,
    };
    app = await createRealtimeApp({
      env,
      db,
      logger,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.modules === undefined ? {} : { modules: options.modules }),
    });
    const address = await app.start({ port: candidates });
    const url = `http://127.0.0.1:${address.port}`;
    const startedApp = app;

    const connect = async (connectOptions: TestConnectOptions = {}) => {
      const guestId = connectOptions.guestId ?? randomUUID();
      const ip = connectOptions.ip === undefined ? nextTestIp() : connectOptions.ip;
      const ticket =
        connectOptions.ticket === undefined
          ? await mintTicket(guestId, { secret: secrets.ticket, ...connectOptions.ticketOptions })
          : connectOptions.ticket;
      const headers: Record<string, string> = { ...connectOptions.headers };
      if (ip !== null) headers[TEST_IP_HEADER] = ip;
      const result = await tryConnect({
        url,
        ticket,
        origin: connectOptions.origin === undefined ? TEST_ORIGIN : connectOptions.origin,
        headers,
        ...(connectOptions.auth === undefined ? {} : { auth: connectOptions.auth }),
        ...(connectOptions.protocolVersion === undefined ? {} : { protocolVersion: connectOptions.protocolVersion }),
        ...(connectOptions.transports === undefined ? {} : { transports: connectOptions.transports }),
        ...(connectOptions.timeoutMs === undefined ? {} : { timeoutMs: connectOptions.timeoutMs }),
      });
      if (!result.ok) return result;
      const client = createTestClient(result.socket, guestId, ip ?? "");
      clients.add(client);
      return { ok: true as const, client };
    };

    let cleaned: Promise<void> | undefined;
    return {
      app: startedApp,
      env,
      database,
      db,
      url,
      port: address.port,
      origin: TEST_ORIGIN,
      secrets: Object.freeze({ ...secrets }),
      mintTicket: (guestId = randomUUID(), ticketOptions = {}) =>
        mintTicket(guestId, { secret: secrets.ticket, ...ticketOptions }),
      async connectClient(connectOptions) {
        const result = await connect(connectOptions);
        if (!result.ok) {
          throw new Error(`Verbindung abgelehnt: ${result.failure.code ?? "Transport"} (${result.failure.message})`);
        }
        return result.client;
      },
      tryConnect: connect,
      request(path, init = {}) {
        const headers: Record<string, string> = { ...init.headers };
        const ip = init.ip === undefined ? nextTestIp() : init.ip;
        if (ip !== null) headers[TEST_IP_HEADER] = ip;
        return fetch(`${url}${path}`, { method: init.method ?? "GET", headers });
      },
      nextIp: nextTestIp,
      cleanup() {
        cleaned ??= (async () => {
          for (const client of clients) client.close();
          clients.clear();
          try {
            await startedApp.stop("test");
          } finally {
            if (ownsDatabase) await database.cleanup();
          }
        })();
        return cleaned;
      },
    };
  } catch (error) {
    for (const client of clients) client.close();
    try {
      await app?.stop("test_setup_failed");
    } finally {
      if (ownsDatabase) await database.cleanup();
    }
    throw error;
  }
}
