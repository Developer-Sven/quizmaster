/**
 * App-Fabrik des Realtime-Servers (docs/02 §Verantwortlichkeiten, docs/07 §Realtime-Server): HTTP-Server,
 * Socket.IO mit Handshake-Schutz, Event-Registry, Dienste und Module – in-process testbar (Test-Harness
 * `test/helpers`). Der Prozess-Einstieg (`index.ts`) ergänzt nur Env, Signale und `process.send("ready")`.
 *
 * Ablauf: `createRealtimeApp()` baut alles auf und ruft `setup()` jedes Moduls; `start()` lädt appConfig,
 * legt die Rate-Limit-Indizes an, startet Überwachung und Modul-Hooks, prüft die Vollständigkeit der
 * Event-Registry und lauscht; `stop()` fährt geordnet herunter (siehe dort).
 */
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  closeMongoClient,
  createMongoClient,
  createRepositories,
  ensureIndexes,
  getCollections,
  MONGO_POOL_SIZES,
  runStartChecks,
} from "@quizmaster/db";
import { type ClientToServerEvents, type ServerToClientEvents, socketServerOptions } from "@quizmaster/shared";
import { defaultAppConfig } from "@quizmaster/shared/documents";
import { Server } from "socket.io";
import { createHandshake } from "./auth/handshake.ts";
import { createTicketVerifier } from "./auth/ticket.ts";
import { RELAXED_LIMIT_FACTOR, type RealtimeEnv } from "./env.ts";
import { createHttpHandler } from "./http.ts";
import { createLogger, createSecurityLog, guestTag, type Logger, toDbLogger } from "./logger.ts";
import { createMetrics, instrumentServerEvents } from "./metrics.ts";
import { REALTIME_MODULES } from "./registry/modules.ts";
import { createEventRegistry, type EventRegistry } from "./registry/registry.ts";
import { roomForGuest } from "./registry/rooms.ts";
import {
  type AdmissionService,
  type AppServer,
  type AppSocket,
  type Clock,
  type HealthService,
  type InterServerEvents,
  type Lifecycle,
  type ModuleContext,
  type RealtimeDb,
  type RealtimeModule,
  type RealtimeServices,
  type SocketData,
  systemClock,
} from "./registry/types.ts";
import { createViolationTracker } from "./registry/violations.ts";
import { createAdmissionService } from "./services/admission.ts";
import { createAppConfigService } from "./services/app-config.ts";
import { createBansService } from "./services/bans.ts";
import { connectionLimits, createConnectionsService } from "./services/connections.ts";
import { createRateLimitService } from "./services/rate-limit.ts";

/** `appName` des MongoClients (sichtbar in Server-Logs/currentOp). */
export const MONGO_APP_NAME = "quizmaster-realtime";
/** Gesamtfrist der Shutdown-Hooks (Snapshots); Exit insgesamt < 10 s. */
export const SHUTDOWN_HOOK_TIMEOUT_MS = 5_000;
/** Danach werden verbliebene HTTP-Verbindungen hart geschlossen. */
export const HTTP_CLOSE_GRACE_MS = 1_000;
/** Höchstens eine Warnung je Regel und Minute bei Ausfall des Rate-Limit-Stores. */
const STORE_ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Verbindet die Datenbank für den Prozess: MongoClient (Pool 20) → Start-Checks (Replica Set, TLS: Pflicht
 * außer bei `*_dev`/`*_test`-Datenbanken) → `ensureIndexes()` → Collections + Repositories.
 */
export async function connectRealtimeDb(env: RealtimeEnv, logger: Logger): Promise<RealtimeDb> {
  const dbLogger = toDbLogger(logger);
  const client = createMongoClient(env.MONGODB_URI, {
    appName: MONGO_APP_NAME,
    maxPoolSize: MONGO_POOL_SIZES.realtime,
    logger: dbLogger,
  });
  try {
    await runStartChecks(client, { logger: dbLogger, allowInsecureTransport: env.databaseKind !== "production" });
    const db = client.db(env.MONGODB_DB);
    const prefix = env.MONGODB_COLLECTION_PREFIX;
    const indexes = await ensureIndexes(db, { prefix, logger: dbLogger });
    logger.info({ indexes: indexes.indexes, validator: indexes.questionsValidator }, "Indizes geprüft");
    const collections = getCollections(db, { prefix });
    return { client, db, collections, repos: createRepositories(client, collections), prefix };
  } catch (error) {
    await closeMongoClient(client).catch((closeError: unknown) => {
      logger.warn({ err: closeError }, "MongoClient nach fehlgeschlagenem Start nicht geschlossen");
    });
    throw error;
  }
}

/** Harte Obergrenze für den Shutdown des Prozesses (docs/07: Exit < 10 s; pm2 `kill_timeout` 15 s). */
export const SHUTDOWN_HARD_LIMIT_MS = 9_000;

/** Ereignisquelle für Signale (Standard: `process`). */
export interface SignalSource {
  on(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  on(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): unknown;
}

export interface ProcessShutdownOptions {
  app: Pick<RealtimeApp, "stop">;
  logger: Logger;
  /** Beendet den Prozess (Standard in index.ts: Logs flushen + `process.exit`). */
  exit: (code: number) => void;
  /** Nach `app.stop()`, z. B. den MongoClient schließen. */
  afterStop?: () => Promise<void>;
  source?: SignalSource;
  hardLimitMs?: number;
}

/**
 * Signale des Prozesses: SIGTERM/SIGINT → `app.stop()` → `afterStop()` → Exit 0 (harte Grenze 9 s → Exit 1);
 * ein zweites Signal während des Shutdowns → sofort Exit 1. Unbehandelte Fehler → Log `fatal`, geordneter
 * Shutdown, Exit 1.
 */
export function installProcessShutdown(options: ProcessShutdownOptions): void {
  const { app, logger, exit } = options;
  const source: SignalSource = options.source ?? process;
  const hardLimitMs = options.hardLimitMs ?? SHUTDOWN_HARD_LIMIT_MS;
  let stopping = false;

  const shutdown = (reason: string, exitCode: number) => {
    if (stopping) {
      logger.warn({ reason }, "Zweites Signal während des Shutdowns – sofortiges Beenden");
      exit(1);
      return;
    }
    stopping = true;
    const hardLimit = setTimeout(() => {
      logger.error({ limitMs: hardLimitMs }, "Shutdown-Frist überschritten – harter Abbruch");
      exit(1);
    }, hardLimitMs);
    hardLimit.unref();
    app
      .stop(reason)
      .then(() => options.afterStop?.())
      .then(
        () => {
          clearTimeout(hardLimit);
          exit(exitCode);
        },
        (error: unknown) => {
          clearTimeout(hardLimit);
          logger.error({ err: error }, "Shutdown fehlgeschlagen");
          exit(1);
        },
      );
  };

  source.on("SIGTERM", () => shutdown("SIGTERM", 0));
  source.on("SIGINT", () => shutdown("SIGINT", 0));
  source.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "Unbehandelte Ausnahme");
    shutdown("uncaughtException", 1);
  });
  source.on("unhandledRejection", (error) => {
    logger.fatal({ err: error }, "Unbehandelte Promise-Ablehnung");
    shutdown("unhandledRejection", 1);
  });
}

export interface CreateRealtimeAppOptions {
  env: RealtimeEnv;
  /** Datenbank; fehlt sie, verbindet die App selbst (`connectRealtimeDb`) und schließt den Client in `stop()`. */
  db?: RealtimeDb;
  clock?: Clock;
  logger?: Logger;
  /** Module (Standard: `REALTIME_MODULES`). */
  modules?: readonly RealtimeModule[];
}

export interface StartOptions {
  /** Standard `HOST` aus der Env. */
  host?: string;
  /** Port oder Kandidaten (bei EADDRINUSE der nächste); Standard `REALTIME_PORT`. */
  port?: number | readonly number[];
}

export interface RealtimeApp {
  readonly env: RealtimeEnv;
  readonly httpServer: HttpServer;
  readonly io: AppServer;
  readonly db: RealtimeDb;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly services: RealtimeServices;
  readonly registry: Pick<EventRegistry, "has" | "registeredEvents" | "missingHandlers" | "limitsOf">;
  start(options?: StartOptions): Promise<AddressInfo>;
  /**
   * Geordneter Shutdown (docs/07, docs/12): keine neuen Verbindungen/Lobbys → `notice SERVER_RESTART` an alle
   * → Shutdown-Hooks (Snapshots, höchstens 5 s) → Sockets und Server schließen → Überwachung beenden →
   * eigenen MongoClient schließen. Idempotent.
   */
  stop(reason?: string): Promise<void>;
  address(): AddressInfo | null;
}

async function listenOnFirstFree(server: HttpServer, host: string, ports: readonly number[]): Promise<AddressInfo> {
  let lastError: unknown = new Error("Kein Port angegeben");
  for (const port of ports) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Unerwartete Server-Adresse");
      return address;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw lastError;
}

/**
 * Prüfungen für `/healthz` (siehe `HealthService`). Eine werfende Prüfung gilt als fehlgeschlagen (fail closed);
 * jeder Wechsel gesund ↔ gestört einer Prüfung wird geloggt.
 */
export function createHealthService(logger: Logger): HealthService {
  const checks = new Map<string, () => boolean>();
  const lastFailing = new Set<string>();
  return {
    register(name, check) {
      if (checks.has(name)) throw new Error(`Health-Prüfung „${name}“ ist bereits registriert`);
      checks.set(name, check);
    },
    failing() {
      const failing: string[] = [];
      for (const [name, check] of checks) {
        let ok: boolean;
        try {
          ok = check();
        } catch (error) {
          logger.error({ err: error, check: name }, "Health-Prüfung fehlgeschlagen");
          ok = false;
        }
        if (!ok) failing.push(name);
        if (!ok && !lastFailing.has(name)) {
          lastFailing.add(name);
          logger.error({ check: name }, "Health-Prüfung meldet Störung – /healthz antwortet 503");
        } else if (ok && lastFailing.delete(name)) {
          logger.info({ check: name }, "Health-Prüfung wieder in Ordnung");
        }
      }
      return failing;
    },
  };
}

async function runWithDeadline(task: Promise<unknown>, ms: number): Promise<"done" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([task.then(() => "done" as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createRealtimeApp(options: CreateRealtimeAppOptions): Promise<RealtimeApp> {
  const { env } = options;
  const logger = options.logger ?? createLogger({ level: env.LOG_LEVEL });
  const clock = options.clock ?? systemClock;
  const ownsDb = options.db === undefined;
  const db = options.db ?? (await connectRealtimeDb(env, logger));

  let shuttingDown = false;
  const lifecycle: Lifecycle = { isShuttingDown: () => shuttingDown };

  const factor = env.RATE_LIMIT_MODE === "relaxed" ? RELAXED_LIMIT_FACTOR : 1;
  const connections = createConnectionsService(connectionLimits(env.MAX_CONNECTIONS, factor));
  const metrics = createMetrics({ socketCount: () => connections.total() });
  const security = createSecurityLog(logger);

  const storeErrorLoggedAt = new Map<string, number>();
  const rateLimit = createRateLimitService({
    mode: env.RATE_LIMIT_MODE,
    store: { client: db.client, dbName: db.db.databaseName, collection: db.collections.rateLimits },
    onStoreError(rule, error) {
      metrics.recordMongoError("rate_limit_store");
      const now = clock.now();
      if (now - (storeErrorLoggedAt.get(rule.id) ?? Number.NEGATIVE_INFINITY) < STORE_ERROR_LOG_INTERVAL_MS) return;
      storeErrorLoggedAt.set(rule.id, now);
      logger.warn({ err: error, rule: rule.id }, "Rate-Limit-Store nicht verfügbar – Memory-Versicherung entscheidet");
    },
  });

  const appConfig = createAppConfigService({
    repo: db.repos.appConfig,
    initial: defaultAppConfig(new Date(clock.now())),
    onListenerError: (error) => logger.error({ err: error }, "appConfig-Listener fehlgeschlagen"),
  });
  const bans = createBansService({ repo: db.repos.bans, connections, clock });
  const health = createHealthService(logger);

  // Lastabwurf und Kontingente für neue Lobbys (docs/06 Schichten 5–6) – inkl. Verbindungsgrenze MAX_CONNECTIONS.
  const admission: AdmissionService = createAdmissionService({ lifecycle, appConfig, metrics, connections });

  const services: RealtimeServices = {
    appConfig,
    bans,
    connections,
    rateLimit,
    metrics,
    admission,
    lifecycle,
    security,
    health,
  };

  const tickets = createTicketVerifier(env.REALTIME_TICKET_SECRET);
  const httpServer = createServer(createHttpHandler({ env, logger, metrics, security, rateLimit, lifecycle, health }));
  // Kurze Fristen gegen langsame Clients (Slowloris); Long-Polling-Antworten betrifft das nicht.
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 15_000;

  const handshake = createHandshake({
    env,
    clock,
    logger,
    security,
    metrics,
    lifecycle,
    rateLimit,
    connections,
    bans,
    appConfig,
    tickets,
  });
  const io: AppServer = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
    httpServer,
    {
      ...socketServerOptions(),
      cors: { origin: [...env.APP_ORIGIN], methods: ["GET", "POST"] },
      // docs/07: kein per-message-deflate (CPU wichtiger als Bytes bei kleinen Nachrichten), ebenso keine
      // Kompression beim Long-Polling. Connection State Recovery bleibt aus (Resync über lobby:resume).
      perMessageDeflate: false,
      httpCompression: false,
      allowRequest: handshake.allowRequest,
    },
  );
  io.use(handshake.middleware);
  // Größe jedes Server→Client-Events (lobby:state = Broadcast-Größe) ohne zweite Serialisierung (metrics.ts).
  instrumentServerEvents(io, metrics);

  const violations = createViolationTracker({ rateLimit, bans, metrics, security, logger });
  const registry = createEventRegistry({
    devBotsEnabled: env.DEV_BOTS_ENABLED,
    clock,
    logger,
    metrics,
    security,
    rateLimit,
    violations,
    lifecycle,
  });

  const connectionListeners: Array<(socket: AppSocket) => void> = [];
  const disconnectListeners: Array<(socket: AppSocket, reason: string) => void> = [];
  const startHooks: Array<() => void | Promise<void>> = [];
  const shutdownHooks: Array<(reason: string) => void | Promise<void>> = [];

  const notify = (label: string, socket: AppSocket, call: () => void) => {
    try {
      call();
    } catch (error) {
      logger.error({ err: error, guest: guestTag(socket.data.guestId) }, `${label} fehlgeschlagen`);
    }
  };

  io.on("connection", (socket) => {
    // Mit dem Memory-Adapter synchron; ein späterer (Mongo-)Adapter liefert ein Promise.
    Promise.resolve(socket.join(roomForGuest(socket.data.guestId))).catch((error: unknown) => {
      logger.error({ err: error, guest: guestTag(socket.data.guestId) }, "Gast-Raum nicht beigetreten");
    });
    registry.attach(socket);
    socket.on("disconnect", (reason) => {
      for (const listener of disconnectListeners) notify("Disconnect-Listener", socket, () => listener(socket, reason));
    });
    for (const listener of connectionListeners) notify("Connection-Listener", socket, () => listener(socket));
  });

  const moduleContext: ModuleContext = {
    env,
    io,
    db,
    logger,
    clock,
    services,
    registerEvent: (event, handler, registerOptions) => registry.register(event, handler, registerOptions),
    onConnection: (listener) => {
      connectionListeners.push(listener);
    },
    onDisconnect: (listener) => {
      disconnectListeners.push(listener);
    },
    onStart: (hook) => {
      startHooks.push(hook);
    },
    onShutdown: (hook) => {
      shutdownHooks.push(hook);
    },
  };
  try {
    for (const module of options.modules ?? REALTIME_MODULES) {
      await module.setup(moduleContext);
    }
  } catch (error) {
    if (ownsDb) await closeMongoClient(db.client);
    throw error;
  }

  const onHeartbeatFailed = () => metrics.recordMongoError("heartbeat");
  const onPoolCleared = () => metrics.recordMongoError("pool_cleared");
  db.client.on("serverHeartbeatFailed", onHeartbeatFailed);
  db.client.on("connectionPoolCleared", onPoolCleared);

  let started = false;
  let stopping: Promise<void> | undefined;

  const closeServer = async () => {
    const force = setTimeout(() => httpServer.closeAllConnections(), HTTP_CLOSE_GRACE_MS);
    force.unref();
    try {
      await io.close();
    } finally {
      clearTimeout(force);
    }
  };

  const stopMonitoring = () => {
    metrics.stop();
    security.stop();
    tickets.stop();
    db.client.off("serverHeartbeatFailed", onHeartbeatFailed);
    db.client.off("connectionPoolCleared", onPoolCleared);
  };

  return {
    env,
    httpServer,
    io,
    db,
    logger,
    clock,
    services,
    registry,

    async start(startOptions = {}) {
      if (started) throw new Error("Realtime-App wurde bereits gestartet");
      if (stopping !== undefined) throw new Error("Realtime-App wurde bereits gestoppt");
      started = true;
      await appConfig.load();
      await rateLimit.ensureStore();
      metrics.start();
      security.start();
      tickets.start(() => clock.now());
      for (const hook of startHooks) await hook();

      const missing = registry.missingHandlers();
      if (missing.length > 0) {
        // Invariante 6: Produktion startet nie mit Events ohne Handler; Entwicklung/Test warnen deutlich.
        if (env.databaseKind === "production") throw new Error(`Kein Handler für: ${missing.join(", ")}`);
        logger.error({ missing }, "Event-Registry unvollständig – nur in Entwicklung/Test zulässig");
      }

      const port = startOptions.port ?? env.REALTIME_PORT;
      const address = await listenOnFirstFree(
        httpServer,
        startOptions.host ?? env.HOST,
        typeof port === "number" ? [port] : port,
      );
      logger.info(
        { host: address.address, port: address.port, events: registry.registeredEvents().length },
        "Realtime-Server bereit",
      );
      return address;
    },

    stop(reason = "stop") {
      stopping ??= (async () => {
        shuttingDown = true;
        logger.info({ reason, sockets: connections.total() }, "Realtime-Server fährt herunter");
        io.emit("notice", { code: "SERVER_RESTART" });
        const hooks = (async () => {
          for (const hook of shutdownHooks) {
            try {
              await hook(reason);
            } catch (error) {
              logger.error({ err: error }, "Shutdown-Hook fehlgeschlagen");
            }
          }
        })();
        if ((await runWithDeadline(hooks, SHUTDOWN_HOOK_TIMEOUT_MS)) === "timeout") {
          logger.error({ timeoutMs: SHUTDOWN_HOOK_TIMEOUT_MS }, "Shutdown-Hooks zu langsam – weiter mit dem Schließen");
        }
        await closeServer();
        stopMonitoring();
        if (ownsDb) await closeMongoClient(db.client);
        logger.info({ reason }, "Realtime-Server gestoppt");
      })();
      return stopping;
    },

    address() {
      const address = httpServer.address();
      return address === null || typeof address === "string" ? null : address;
    },
  };
}
