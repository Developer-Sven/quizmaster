/**
 * Gemeinsame Typen des Realtime-Kerns: Socket-Typen, Event-Handler, Module und Dienste. Lobby/Spiel
 * (Handler-Module) und Watcher bauen ausschließlich auf diesen Verträgen auf.
 */
import type { Collections, Repositories } from "@quizmaster/db";
import type {
  ClientEventAckData,
  ClientEventName,
  ClientEventPayload,
  ClientToServerEvents,
  ErrorCode,
  ServerToClientEvents,
} from "@quizmaster/shared";
import type { Db, MongoClient } from "mongodb";
import type { Server, Socket } from "socket.io";
import type { RealtimeEnv } from "../env.ts";
import type { Logger, SecurityLog } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import type { AppConfigService } from "../services/app-config.ts";
import type { BansService } from "../services/bans.ts";
import type { ConnectionsService } from "../services/connections.ts";
import type { RateLimitService } from "../services/rate-limit.ts";

/** Daten eines authentifizierten Sockets (`socket.data`), gesetzt von der Auth-Middleware. */
export interface SocketData {
  /** Aus dem Ticket (`sub`) – GEHEIM, nie in Payloads an Clients. */
  guestId: string;
  /** HMAC-IP-Schlüssel (`@quizmaster/shared/ip`); `null`, wenn die IP nicht bestimmbar war. */
  ipKey: string | null;
  /** Zeitpunkt (ms) einer serverseitig verifizierten Turnstile-Prüfung aus dem Ticket (`tsv`), sonst `null`. */
  ticketTsv: number | null;
}

/** Server→Server-Events (erst bei mehreren Instanzen, docs/07 Stufe 2). */
export type InterServerEvents = Record<never, never>;

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** Uhr der App (Serverzeit in ms); in Tests ersetzbar. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

declare const ackSentBrand: unique symbol;
/** Marke: das Erfolgs-Ack wurde bereits über `ctx.ack()` gesendet. */
export interface AckSent {
  readonly [ackSentBrand]: true;
}

/** Kontext eines Client-Events (docs/02 §Fehlerbehandlung). */
export interface EventContext<E extends ClientEventName = ClientEventName> {
  readonly event: E;
  readonly socket: AppSocket;
  readonly guestId: string;
  readonly ipKey: string | null;
  /** Eindeutige ID dieser Anfrage (steht in allen Logs zum Event). */
  readonly requestId: string;
  /** Serverzeit beim Eingang (ms). */
  readonly now: number;
  /** Logger mit `requestId`, `event` und gekürzter Gast-ID. */
  readonly log: Logger;
  /**
   * Sendet das Erfolgs-Ack sofort (z. B. vor den Effects der Engine: „Ack senden, dann Effects ausführen“)
   * und liefert die Marke, die der Handler am Ende zurückgibt. Danach geworfene Fehler werden nur geloggt.
   */
  ack(data: ClientEventAckData<E>): AckSent;
}

/** Ergebnis eines Handlers: Ack-Daten (Wrapper sendet `{ ok: true, data }`) oder die Marke aus `ctx.ack()`. */
export type EventHandlerResult<E extends ClientEventName> = ClientEventAckData<E> | AckSent;

/**
 * Handler eines Client-Events. Der Payload ist bereits validiert (zod), Limits sind geprüft. Fachliche
 * Fehler als `ProtocolError` werfen – der Wrapper antwortet mit dem Code; alles andere wird `INTERNAL`.
 */
export type EventHandler<E extends ClientEventName> = (
  payload: ClientEventPayload<E>,
  ctx: EventContext<E>,
) => EventHandlerResult<E> | Promise<EventHandlerResult<E>>;

export interface RegisterEventOptions<E extends ClientEventName = ClientEventName> {
  /**
   * Für Regeln mit `consume: "failure"` (z. B. fehlgeschlagene `lobby:join` je IP): welche Fehlercodes als
   * Fehlversuch zählen. Standard: `isFailedAttempt` (alle fachlichen Ablehnungen außer Server-Zuständen).
   */
  countsAsFailure?: (code: ErrorCode) => boolean;
  /**
   * Für Regeln mit `consume: "failure"`: Anfragen, die eine bestehende Fehlversuchs-Sperre nicht betrifft – etwa
   * Mitglieder, die in ihre eigene Lobby zurückkehren (kein Code-Raten; die IP-Sperre träfe sonst Unbeteiligte
   * derselben IP). Bekommt den validierten Payload und die guestId; `true` = Sperre überspringen (die übrigen
   * Limits gelten weiter). Darf nur verraten, was die Person schon weiß; ein Fehler gilt als `false` (Sperre bleibt).
   */
  skipFailureBlock?: (payload: ClientEventPayload<E>, guestId: string) => boolean;
}

/** Zugriff auf die Datenbank (ein Client pro Prozess, Collections ggf. mit Test-Präfix). */
export interface RealtimeDb {
  client: MongoClient;
  db: Db;
  collections: Collections;
  repos: Repositories;
  /** Collection-Präfix (nur Tests, `*_test`-Datenbanken). */
  prefix: string | undefined;
}

/** Laufzustand der App. */
export interface Lifecycle {
  /** true ab `stop()`: keine neuen Verbindungen und Lobbys mehr. */
  isShuttingDown(): boolean;
}

/** Zulassungsregeln für neue Lobbys (Kill-Switch, Kontingent, Lastabwurf, Shutdown). */
export interface AdmissionService {
  /**
   * Darf jetzt eine neue Lobby entstehen? `null` = ja, sonst der Fehlercode für das Ack:
   * Shutdown → SERVER_BUSY, `lobbyCreationEnabled=false` → LOBBY_CREATION_DISABLED,
   * Lastabwurf → SERVER_BUSY, `activeLobbies ≥ maxActiveLobbies` → SERVER_BUSY.
   */
  lobbyCreation(activeLobbies: number): ErrorCode | null;
}

/**
 * Zusätzliche Bedingungen für `GET /healthz` (neben „nicht im Shutdown“), z. B. „Fragenkatalog brauchbar“ in
 * Produktion. Die Antwort bleibt ohne Details (`{ ok }`); die Namen erscheinen nur im Log.
 */
export interface HealthService {
  /** Registriert eine Prüfung; `false` (oder ein Fehler) → `/healthz` antwortet 503 `{ ok: false }`. */
  register(name: string, check: () => boolean): void;
  /** Namen der gerade fehlschlagenden Prüfungen (leer = gesund). */
  failing(): string[];
}

export interface RealtimeServices {
  appConfig: AppConfigService;
  bans: BansService;
  connections: ConnectionsService;
  rateLimit: RateLimitService;
  metrics: RealtimeMetrics;
  admission: AdmissionService;
  lifecycle: Lifecycle;
  security: SecurityLog;
  health: HealthService;
}

/** Was ein Modul (Lobby/Spiel, Watcher …) beim Aufbau der App bekommt. */
export interface ModuleContext {
  readonly env: RealtimeEnv;
  readonly io: AppServer;
  readonly db: RealtimeDb;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly services: RealtimeServices;
  /**
   * Registriert den Handler eines Client-Events (einmal je Event). Wirft, wenn es für das Event kein
   * Rate-Limit gibt (Invariante 6) oder es schon registriert ist. `devOnly`-Events werden ohne
   * `DEV_BOTS_ENABLED` nicht registriert (Rückgabe `false`) – sie gelten dann als unbekannt.
   */
  registerEvent<E extends ClientEventName>(
    event: E,
    handler: EventHandler<E>,
    options?: RegisterEventOptions<E>,
  ): boolean;
  /** Nach erfolgreicher Authentifizierung (Socket ist bereits im Gast-Raum). */
  onConnection(listener: (socket: AppSocket) => void): void;
  /** Nach dem Trennen; die Verbindungszähler sind dann schon aktualisiert (`connections.countForGuest`). */
  onDisconnect(listener: (socket: AppSocket, reason: string) => void): void;
  /** Vor `listen()` in `start()` (z. B. Fragenpool laden, Watcher starten). Fehler brechen den Start ab. */
  onStart(hook: () => void | Promise<void>): void;
  /** In `stop()` nach `notice SERVER_RESTART` und vor dem Schließen der Sockets (z. B. Snapshots schreiben). */
  onShutdown(hook: (reason: string) => void | Promise<void>): void;
}

/** Baustein der App (Handler-Gruppe, Watcher …); `setup` läuft einmal in `createRealtimeApp()`. */
export interface RealtimeModule {
  readonly name: string;
  setup(context: ModuleContext): void | Promise<void>;
}
