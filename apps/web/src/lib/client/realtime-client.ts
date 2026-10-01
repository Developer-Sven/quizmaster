/**
 * Realtime-Client (docs/05 §Verbindung, §Reconnect; docs/10 §App-Gefühl): eine Socket.IO-Verbindung pro
 * Seite (Singleton), `auth` als Funktion – jeder Verbindungsversuch holt ein frisches Ticket. Die Gast-Session
 * (`POST /api/session`) wird nur angelegt, wenn nötig: beim ersten Besuch (kein Session-Merker) oder wenn das
 * Ticket 401 liefert. Ablehnungen des Servers werden je Code behandelt: `UNAUTHORIZED` → still neu anmelden
 * (einmal), `UPDATE_REQUIRED` → Banner, Sperre → Hinweis, vorübergehende Codes → Neuversuch mit Backoff
 * (≤ 5 s bzw. Retry-After, höchstens 30 s); wartende Aktionen erfahren RATE_LIMITED, SERVER_BUSY und
 * TOO_MANY_CONNECTIONS sofort. Nach jedem (Re-)Connect: Uhrenabgleich und `lobby:resume { code }` → Server
 * schickt `lobby:state` + `lobby:self`. Alle Server-Payloads werden mit den gemeinsamen zod-Schemas geprüft,
 * bevor sie in den Store gehen; passt ein Zustand nicht, synchronisiert der Client einmal neu und zeigt danach
 * „Neue Version verfügbar“ statt still einzufrieren.
 *
 * Nur im Browser verwenden (Lobby-/Spielseiten; die Startseite lädt dieses Modul erst bei Bedarf).
 */
import {
  ackResponseSchema,
  CLIENT_EVENTS,
  type ClientEventAckData,
  type ClientEventName,
  type ClientEventPayloadInput,
  type ClientToServerEvents,
  type ErrorCode,
  isErrorCode,
  kickedSchema,
  noticeSchema,
  PROTOCOL_VERSION,
  privatePlayerStateSchema,
  publicLobbyStateSchema,
  type ServerToClientEvents,
  socketClientOptions,
} from "@quizmaster/shared";
import { io, type Socket } from "socket.io-client";
import type { z } from "zod";
import { gameActions, type LobbyExit, useGameStore } from "../../stores/game-store";
import { parseStoredCategories, serializeCategories } from "./categories";
import { createClockSync } from "./clock-sync";
import {
  type ClientErrorCode,
  connectFailure,
  parseConnectErrorCode,
  parseConnectErrorRetryAfterMs,
  resumeFailure,
} from "./errors";
import { ApiError, ensureSession, fetchTicket } from "./session";
import { readSessionHint, readStoredCategories, writeMembership, writeStoredCategories } from "./storage";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Ergebnis einer Aktion mit Ack. `NETWORK` = kein Ack (Zeitüberschreitung, Trennung, kein Netz). */
export type EmitResult<T> = { ok: true; data: T } | { ok: false; code: ClientErrorCode; retryAfterMs?: number };

export interface RealtimeClientConfig {
  /** Realtime-URL aus der Laufzeit-Konfiguration (ADR-023); "" = gleiche Origin */
  realtimeUrl: string;
}

/** Liefert ein Turnstile-Token, wenn Session oder Ticket es verlangen (Widget: W4); `null` = abgebrochen. */
export type TurnstileProvider = () => Promise<string | null>;

export interface EmitOptions {
  /** Wartezeit auf das Ack in ms (Standard 8 s) */
  timeoutMs?: number;
  /** Ohne Verbindung sofort mit `NETWORK` scheitern statt bis zu 10 s auf sie zu warten */
  requireConnection?: boolean;
}

export interface RealtimeClient {
  readonly url: string;
  /** Verbindung anfordern (idempotent). */
  connect(): void;
  /** Wartet auf die Verbindung: `null` = verbunden, sonst endgültiger Fehler oder `NETWORK` (Zeitablauf). */
  whenConnected(timeoutMs?: number): Promise<ClientErrorCode | null>;
  /** Typisiertes Event mit Ack und Timeout; die Antwort wird gegen das Ack-Schema geprüft. */
  emit<E extends ClientEventName>(
    event: E,
    payload: ClientEventPayloadInput<E>,
    options?: EmitOptions,
  ): Promise<EmitResult<ClientEventAckData<E>>>;
  /** Lobby-Seite betreten: Code merken, verbinden und (falls nötig) per `lobby:resume` synchronisieren. */
  enterLobby(code: string): void;
  /** Lobby-Seite verlassen (ohne `lobby:leave`): Kontext und Verbindung kurz darauf freigeben. */
  releaseLobby(): void;
  createLobby(name: string): Promise<EmitResult<ClientEventAckData<"lobby:create">>>;
  joinLobby(code: string, name: string): Promise<EmitResult<ClientEventAckData<"lobby:join">>>;
  /** `lobby:leave` (im Spiel = Aufgeben) und Lobby-Kontext beenden. */
  leaveLobby(): Promise<EmitResult<null>>;
  /** Still per `lobby:resume` neu synchronisieren (Fehlercodes der Art „resync“). */
  resync(): void;
  /** Uhrenabgleich jetzt. */
  syncClock(): void;
  /** Turnstile-Anbieter setzen (W4). */
  setTurnstileProvider(provider: TurnstileProvider | null): void;
  /** Verbindung beenden (kein automatischer Neuversuch). */
  disconnect(): void;
  /** Singleton aufräumen (URL-Wechsel, Tests). */
  dispose(): void;
}

const ACK_TIMEOUT_MS = 8_000;
const CONNECT_WAIT_MS = 10_000;
const TIME_SYNC_TIMEOUT_MS = 3_000;
const RELEASE_DELAY_MS = 1_500;
const RETRY_BASE_MS = 1_000;
/** Backoff höchstens 5 s (docs/05 §Reconnect). */
const RETRY_MAX_MS = 5_000;
const RESUME_RETRY_MS = 2_000;
/** Wartezeiten des Servers (Retry-After bis 10 min) für den automatischen Neuversuch deckeln. */
const MAX_REJECTION_RETRY_MS = 30_000;

/**
 * Vorübergehende Ablehnungen, die wartende Aktionen sofort erfahren – mit eigenem Text statt nach 10 s nur
 * „Verbindung unterbrochen“. Der Client versucht es trotzdem im Hintergrund weiter.
 */
const SURFACED_REJECTIONS: ReadonlySet<ClientErrorCode> = new Set<ClientErrorCode>([
  "RATE_LIMITED",
  "SERVER_BUSY",
  "TOO_MANY_CONNECTIONS",
]);

/** Backoff mit Streuung: 1 s, 2 s, 4 s, 5 s … (jeweils 50–100 %). */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.5 + random() * 0.5));
}

/** Neuversuch nach einer Ablehnung: Wartezeit des Servers, höchstens 30 s; ohne Angabe der normale Backoff. */
export function rejectionRetryDelayMs(retryAfterMs: number | undefined): number | undefined {
  return retryAfterMs === undefined ? undefined : Math.min(Math.max(0, retryAfterMs), MAX_REJECTION_RETRY_MS);
}

/** Meldet ein Zustand eine neuere Protokollversion als dieser Client (Client veraltet → neu laden)? */
function newerProtocol(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const version = (payload as { protocolVersion?: unknown }).protocolVersion;
  return typeof version === "number" && version > PROTOCOL_VERSION;
}

const ackSchemas = new Map<ClientEventName, z.ZodType>();

function ackSchemaFor(event: ClientEventName): z.ZodType {
  let schema = ackSchemas.get(event);
  if (!schema) {
    schema = ackResponseSchema(CLIENT_EVENTS[event].ack);
    ackSchemas.set(event, schema);
  }
  return schema;
}

/** Prüft ein Ack gegen das Schema des Events; unerwartete Antworten gelten als `INTERNAL`. */
export function parseAck<E extends ClientEventName>(event: E, response: unknown): EmitResult<ClientEventAckData<E>> {
  const parsed = ackSchemaFor(event).safeParse(response);
  if (!parsed.success) return { ok: false, code: "INTERNAL" };
  const value = parsed.data as
    | { ok: true; data: unknown }
    | { ok: false; error: { code: ErrorCode; retryAfterMs?: number } };
  if (value.ok) return { ok: true, data: value.data as ClientEventAckData<E> };
  return value.error.retryAfterMs === undefined
    ? { ok: false, code: value.error.code }
    : { ok: false, code: value.error.code, retryAfterMs: value.error.retryAfterMs };
}

/** Kurze Beschreibung eines Schemafehlers für Logs (nur Pfade, keine Inhalte). */
function issuePaths(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => issue.path.join(".") || "(root)")
    .join(", ");
}

function createRealtimeClient(config: RealtimeClientConfig): RealtimeClient {
  let lobbyCode: string | null = null;
  /** create/join läuft: Zustände dürfen schon vor dem Ack-Ergebnis in den Store */
  let entriesInFlight = 0;
  let wanted = false;
  let reauthAttempted = false;
  let forceNewSession = false;
  let turnstileNeeded = false;
  let turnstileProvider: TurnstileProvider | null = null;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let resumeInFlight = false;
  /** Letzte vorübergehende Ablehnung seit dem letzten Verbindungsaufbau (Ergebnis für wartende Aktionen). */
  let lastRejection: ClientErrorCode | null = null;
  /** Schemawidrige Zustände in Folge je Event: der erste löst einen Resync aus, der zweite „Neue Version“. */
  const invalidStreak = { "lobby:state": 0, "lobby:self": 0 };
  const waiters = new Set<(result: ClientErrorCode | null) => void>();

  /** `POST /api/session` (bei TURNSTILE_REQUIRED einmal mit Turnstile-Token). */
  async function sessionReady(): Promise<void> {
    try {
      await ensureSession();
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "TURNSTILE_REQUIRED" || !turnstileProvider) throw error;
      const token = await turnstileProvider();
      if (!token) throw error;
      await ensureSession({ turnstileToken: token });
    }
  }

  /**
   * Ticket holen – mit Session-Merker direkt (empfohlener Ablauf der Web-API, kein `POST /api/session` bei jedem
   * Seitenaufruf), ohne Merker bzw. nach einer Neuanmeldung erst die Session. 401 → einmal Session, dann erneut.
   */
  async function obtainTicket(): Promise<string> {
    if (forceNewSession || !readSessionHint()) {
      forceNewSession = false;
      await sessionReady();
    }
    const token = turnstileNeeded && turnstileProvider ? await turnstileProvider() : null;
    try {
      return await fetchTicket(token);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === "UNAUTHORIZED" && !reauthAttempted) {
        // Kein gültiges Session-Cookie (abgelaufen, gelöscht, Gast entfernt): einmal neu anlegen.
        reauthAttempted = true;
        await sessionReady();
        return fetchTicket(token);
      }
      if (error.code === "TURNSTILE_REQUIRED" && turnstileProvider && !token) {
        const fresh = await turnstileProvider();
        if (fresh) return fetchTicket(fresh);
      }
      throw error;
    }
  }

  const socketOptions = {
    ...socketClientOptions(),
    autoConnect: false,
    auth: (send: (data: object) => void) => {
      obtainTicket().then(
        (ticket) => send({ ticket, protocolVersion: PROTOCOL_VERSION }),
        (error: unknown) => onTicketFailure(error),
      );
    },
  };
  const socket: ClientSocket = config.realtimeUrl ? io(config.realtimeUrl, socketOptions) : io(socketOptions);
  /** Für Emits mit generischem Eventnamen (Typprüfung übernimmt `emit` selbst). */
  const rawSocket = socket as unknown as Socket;

  const clock = createClockSync({
    requestServerTime: async (t0) => {
      const result = await emit("time:sync", { t0 }, { timeoutMs: TIME_SYNC_TIMEOUT_MS, requireConnection: true });
      return result.ok ? result.data.serverNow : null;
    },
    onOffset: (offset) => gameActions.setOffset(offset),
  });

  function resolveWaiters(result: ClientErrorCode | null): void {
    for (const waiter of [...waiters]) waiter(result);
  }

  function clearRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function cancelRelease(): void {
    if (releaseTimer !== null) clearTimeout(releaseTimer);
    releaseTimer = null;
  }

  function scheduleReconnect(delayMs?: number): void {
    clearRetry();
    if (!wanted || useGameStore.getState().connection.fatal) return;
    const delay = delayMs ?? retryDelayMs(retryAttempt);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (wanted && !socket.connected && !socket.active) socket.connect();
    }, delay);
  }

  /** Endgültiger Fehler: Verbindung beenden, Store informieren, Wartende freigeben. */
  function fail(code: ErrorCode): void {
    wanted = false;
    clearRetry();
    clock.stop();
    socket.disconnect();
    gameActions.connectionFatal(code);
    resolveWaiters(code);
  }

  /**
   * Vorübergehende Ablehnung (Session, Ticket oder Handshake): merken, wartende Aktionen bei RATE_LIMITED,
   * SERVER_BUSY und TOO_MANY_CONNECTIONS sofort informieren und später erneut versuchen (≤ 30 s).
   */
  function rejected(code: ClientErrorCode, retryAfterMs: number | undefined): void {
    gameActions.connectionLost(Date.now());
    if (code !== "NETWORK") {
      gameActions.connectionRejected(code);
      lastRejection = code;
      if (SURFACED_REJECTIONS.has(code)) resolveWaiters(code);
    }
    scheduleReconnect(rejectionRetryDelayMs(retryAfterMs));
  }

  /** Ticket/Session nicht erhältlich: endgültige Codes beenden, alles andere später erneut versuchen. */
  function onTicketFailure(error: unknown): void {
    const code: ClientErrorCode = error instanceof ApiError ? error.code : "INTERNAL";
    if (
      code === "UNAUTHORIZED" ||
      code === "UPDATE_REQUIRED" ||
      code === "BANNED" ||
      (code === "TURNSTILE_REQUIRED" && !turnstileProvider)
    ) {
      fail(code);
      return;
    }
    socket.disconnect();
    rejected(code, error instanceof ApiError ? error.retryAfterMs : undefined);
  }

  /** Server hat den Verbindungsaufbau mit Code abgelehnt (Socket ist danach inaktiv). */
  function onRejected(code: ErrorCode, retryAfterMs: number | undefined): void {
    switch (connectFailure(code)) {
      case "reauth":
        if (reauthAttempted) {
          fail(code);
        } else {
          reauthAttempted = true;
          forceNewSession = true;
          scheduleReconnect(0);
        }
        return;
      case "turnstile":
        if (!turnstileProvider) {
          fail(code);
        } else {
          turnstileNeeded = true;
          scheduleReconnect(0);
        }
        return;
      case "fatal":
        fail(code);
        return;
      case "retry":
        rejected(code, retryAfterMs);
        return;
    }
  }

  function exitWith(exit: LobbyExit): void {
    lobbyCode = null;
    writeMembership(null);
    gameActions.exitLobby(exit);
  }

  function adoptLobby(code: string): void {
    lobbyCode = code;
    writeMembership(code);
    gameActions.enterLobby(code, parseStoredCategories(readStoredCategories(), code));
  }

  async function resume(): Promise<void> {
    const code = lobbyCode;
    if (code === null || resumeInFlight || !socket.connected) return;
    if (resumeTimer !== null) clearTimeout(resumeTimer);
    resumeTimer = null;
    resumeInFlight = true;
    gameActions.beginResync();
    const result = await emit("lobby:resume", { code });
    resumeInFlight = false;
    if (code !== lobbyCode) return;
    if (result.ok) {
      gameActions.resumed();
      return;
    }
    switch (resumeFailure(result.code)) {
      case "exit":
        exitWith({ kind: "error", code: result.code === "NETWORK" ? "INTERNAL" : result.code });
        return;
      case "reauth":
        reconnectWithNewSession();
        return;
      case "fatal":
        if (result.code !== "NETWORK") fail(result.code);
        return;
      case "retry":
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          void resume();
        }, result.retryAfterMs ?? RESUME_RETRY_MS);
        return;
    }
  }

  /** Session erneuern und neu verbinden (z. B. `UNAUTHORIZED` auf ein Event). */
  function reconnectWithNewSession(): void {
    if (reauthAttempted) {
      fail("UNAUTHORIZED");
      return;
    }
    reauthAttempted = true;
    forceNewSession = true;
    socket.disconnect();
    gameActions.connectionLost(Date.now());
    scheduleReconnect(0);
  }

  function inLobbyContext(): boolean {
    return lobbyCode !== null || entriesInFlight > 0;
  }

  /**
   * Server-Zustand passt nicht zum Schema (z. B. neues Feld nach einem Realtime-Deploy, ADR-025, oder ein
   * Projektionsfehler): nicht still einfrieren. Neueres Protokoll → sofort „Neue Version verfügbar“; sonst
   * einmal neu synchronisieren – passt auch der nächste Zustand nicht, ebenso (Neuladen holt den Client).
   */
  function onInvalidState(event: keyof typeof invalidStreak, payload: unknown, error: z.ZodError): void {
    console.error(`${event} verworfen (Schema):`, issuePaths(error));
    if (!inLobbyContext()) return;
    if (newerProtocol(payload)) {
      fail("UPDATE_REQUIRED");
      return;
    }
    invalidStreak[event] += 1;
    if (invalidStreak[event] === 1) void resume();
    else fail("UPDATE_REQUIRED");
  }

  socket.on("connect", () => {
    reauthAttempted = false;
    turnstileNeeded = false;
    lastRejection = null;
    retryAttempt = 0;
    clearRetry();
    gameActions.connected();
    resolveWaiters(null);
    clock.start();
    void resume();
  });

  socket.on("disconnect", (reason) => {
    clock.stop();
    if (!wanted) return;
    gameActions.connectionLost(Date.now());
    // Vom Server getrennt (z. B. Neustart): Socket.IO verbindet dann nicht von selbst neu.
    if (reason === "io server disconnect") scheduleReconnect();
  });

  socket.on("connect_error", (error) => {
    const code = parseConnectErrorCode(error, isErrorCode);
    if (code !== null && !socket.active) {
      onRejected(code, parseConnectErrorRetryAfterMs(error));
      return;
    }
    // Transportfehler: Socket.IO versucht es selbst erneut (Backoff bis 5 s).
    if (wanted) gameActions.connectionLost(Date.now());
  });

  socket.on("lobby:state", (payload) => {
    const parsed = publicLobbyStateSchema.safeParse(payload);
    if (!parsed.success) {
      onInvalidState("lobby:state", payload, parsed.error);
      return;
    }
    invalidStreak["lobby:state"] = 0;
    if (inLobbyContext()) gameActions.applyPublicState(parsed.data);
  });

  socket.on("lobby:self", (payload) => {
    const parsed = privatePlayerStateSchema.safeParse(payload);
    if (!parsed.success) {
      onInvalidState("lobby:self", payload, parsed.error);
      return;
    }
    invalidStreak["lobby:self"] = 0;
    if (inLobbyContext()) gameActions.applyPrivateState(parsed.data);
  });

  socket.on("notice", (payload) => {
    const parsed = noticeSchema.safeParse(payload);
    if (parsed.success) gameActions.applyNotice(parsed.data.code);
    else console.error("notice verworfen (Schema):", issuePaths(parsed.error));
  });

  socket.on("kicked", (payload) => {
    const parsed = kickedSchema.safeParse(payload);
    exitWith({ kind: "kicked", reason: parsed.success ? parsed.data.reason : "host" });
  });

  // Kategorien der Lobby über ein Neuladen hinweg merken (nur die aktuelle Lobby).
  const unsubscribeCategories = useGameStore.subscribe((state, previous) => {
    if (state.categories !== previous.categories && state.code !== null && Object.keys(state.categories).length > 0) {
      writeStoredCategories(serializeCategories(state.code, state.categories));
    }
  });

  // Rückkehr in den Vordergrund / Netzwechsel (docs/10 §App-Gefühl).
  const onVisibility = () => {
    if (document.visibilityState !== "visible" || !wanted) return;
    if (socket.connected) {
      void clock.syncNow();
      void resume();
    } else if (!socket.active) {
      socket.connect();
    }
  };
  const onOffline = () => {
    if (wanted && inLobbyContext()) gameActions.wentOffline(Date.now());
  };
  const onOnline = () => {
    gameActions.wentOnline();
    if (!wanted || socket.connected) return;
    // Sofort neu versuchen statt auf den nächsten Backoff-Schritt zu warten.
    socket.disconnect();
    socket.connect();
  };
  if (typeof window !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
  }

  function connect(): void {
    cancelRelease();
    if (useGameStore.getState().connection.fatal) return;
    wanted = true;
    if (socket.connected || socket.active) return;
    gameActions.connecting();
    socket.connect();
  }

  function whenConnected(timeoutMs = CONNECT_WAIT_MS): Promise<ClientErrorCode | null> {
    if (socket.connected) return Promise.resolve(null);
    const fatal = useGameStore.getState().connection.fatal;
    if (fatal) return Promise.resolve(fatal);
    connect();
    return new Promise((resolve) => {
      const finish = (result: ClientErrorCode | null) => {
        clearTimeout(timer);
        waiters.delete(finish);
        resolve(result);
      };
      // Zeitablauf: die letzte vorübergehende Ablehnung (z. B. INTERNAL) ist aussagekräftiger als „NETWORK“.
      const timer = setTimeout(() => finish(lastRejection ?? "NETWORK"), timeoutMs);
      waiters.add(finish);
    });
  }

  async function emit<E extends ClientEventName>(
    event: E,
    payload: ClientEventPayloadInput<E>,
    options: EmitOptions = {},
  ): Promise<EmitResult<ClientEventAckData<E>>> {
    if (!socket.connected) {
      if (options.requireConnection) return { ok: false, code: "NETWORK" };
      const failure = await whenConnected();
      if (failure !== null) return { ok: false, code: failure };
    }
    let response: unknown;
    try {
      response = await rawSocket.timeout(options.timeoutMs ?? ACK_TIMEOUT_MS).emitWithAck(event, payload);
    } catch {
      // Kein Ack (Zeitüberschreitung oder Trennung) – der Aufrufer zeigt „Verbindung unterbrochen“ bzw. synchronisiert.
      return { ok: false, code: "NETWORK" };
    }
    const result = parseAck(event, response);
    if (!result.ok && result.code === "UNAUTHORIZED") reconnectWithNewSession();
    return result;
  }

  function disconnect(): void {
    wanted = false;
    clearRetry();
    cancelRelease();
    if (resumeTimer !== null) clearTimeout(resumeTimer);
    resumeTimer = null;
    clock.stop();
    socket.disconnect();
  }

  return {
    url: config.realtimeUrl,
    connect,
    whenConnected,
    emit,
    enterLobby(code) {
      cancelRelease();
      const alreadyThere = lobbyCode === code;
      lobbyCode = code;
      const state = useGameStore.getState();
      if (state.code !== code || state.exit) {
        gameActions.enterLobby(code, parseStoredCategories(readStoredCategories(), code));
      }
      connect();
      if (socket.connected && !(alreadyThere && useGameStore.getState().lobby?.code === code)) void resume();
    },
    releaseLobby() {
      cancelRelease();
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        lobbyCode = null;
        gameActions.resetLobby();
        disconnect();
      }, RELEASE_DELAY_MS);
    },
    async createLobby(name) {
      entriesInFlight += 1;
      const result = await emit("lobby:create", { name });
      entriesInFlight -= 1;
      if (result.ok) adoptLobby(result.data.code);
      return result;
    },
    async joinLobby(code, name) {
      entriesInFlight += 1;
      const result = await emit("lobby:join", { code, name });
      entriesInFlight -= 1;
      if (result.ok) adoptLobby(result.data.code);
      return result;
    },
    async leaveLobby() {
      const result = await emit("lobby:leave", {}, { requireConnection: true });
      lobbyCode = null;
      writeMembership(null);
      gameActions.resetLobby();
      return result;
    },
    resync() {
      void resume();
    },
    syncClock() {
      void clock.syncNow();
    },
    setTurnstileProvider(provider) {
      turnstileProvider = provider;
    },
    disconnect,
    dispose() {
      disconnect();
      unsubscribeCategories();
      socket.removeAllListeners();
      if (typeof window !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("offline", onOffline);
        window.removeEventListener("online", onOnline);
      }
    },
  };
}

let instance: RealtimeClient | null = null;

/** Der Realtime-Client dieser Seite (einer je Realtime-URL). */
export function getRealtimeClient(config: RealtimeClientConfig): RealtimeClient {
  if (instance && instance.url === config.realtimeUrl) return instance;
  instance?.dispose();
  instance = createRealtimeClient(config);
  return instance;
}
