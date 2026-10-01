/**
 * socket.io-client-Hilfen für Integrationstests: Verbinden (inkl. gezielter Fehlversuche), Events mit Ack
 * senden (Ack-Format wird gegen das Schema des Events geprüft), auf Server-Events warten. Jeder Test-Client
 * protokolliert alle empfangenen Server-Events und prüft sie gegen `SERVER_EVENTS` und Invariante 4
 * (keine `guestId` in Client-Payloads) → `contractViolations` muss leer bleiben.
 */
import {
  type AckResponse,
  ackResponseSchema,
  CLIENT_EVENTS,
  CLIENT_FORBIDDEN_KEYS,
  type ClientEventAckData,
  type ClientEventName,
  type ClientEventPayloadInput,
  type ClientToServerEvents,
  type ErrorCode,
  errorCodeSchema,
  findKeysDeep,
  PROTOCOL_VERSION,
  SERVER_EVENTS,
  type ServerEventName,
  type ServerEventPayload,
  type ServerToClientEvents,
  SOCKET_PATH,
} from "@quizmaster/shared";
import { io, type Socket } from "socket.io-client";
import { z } from "zod";

export type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const DEFAULT_ACK_TIMEOUT_MS = 5_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Ungetypte Sicht auf den Socket – nur für absichtlich ungültige Nachrichten in Tests. */
interface UntypedSocket {
  emit(event: string | number, ...args: unknown[]): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

function untyped(socket: TestSocket): UntypedSocket {
  return socket as unknown as UntypedSocket;
}

/** Sendet ein beliebiges Event mit beliebigen Argumenten und wartet auf das (ungeprüfte) Ack. */
export function emitRawWithAck(
  socket: TestSocket,
  event: string | number,
  args: readonly unknown[],
  timeoutMs = DEFAULT_ACK_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Kein Ack auf „${String(event)}“ innerhalb von ${timeoutMs} ms`)),
      timeoutMs,
    );
    untyped(socket).emit(event, ...args, (response: unknown) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/** Sendet ein beliebiges Event ohne Ack-Callback. */
export function emitRaw(socket: TestSocket, event: string | number, ...args: unknown[]): void {
  untyped(socket).emit(event, ...args);
}

/**
 * Sendet ein Client-Event und liefert das Ack. Das Ack muss exakt dem Ack-Format (docs/05) mit den
 * Ack-Daten des Events entsprechen – sonst wirft die Hilfe.
 */
export async function emitWithAck<E extends ClientEventName>(
  socket: TestSocket,
  event: E,
  payload: ClientEventPayloadInput<E>,
  timeoutMs = DEFAULT_ACK_TIMEOUT_MS,
): Promise<AckResponse<ClientEventAckData<E>>> {
  const response = await emitRawWithAck(socket, event, [payload], timeoutMs);
  const parsed = ackResponseSchema(CLIENT_EVENTS[event].ack).safeParse(response);
  if (!parsed.success) {
    throw new Error(`Ack auf „${event}“ verletzt das Ack-Format: ${JSON.stringify(response)}`);
  }
  return parsed.data as AckResponse<ClientEventAckData<E>>;
}

/**
 * Wartet auf ein Server-Event (optional mit Bedingung). Payloads werden gegen `SERVER_EVENTS` geprüft.
 * Vor der auslösenden Aktion aufrufen, sonst kann das Event schon vorbei sein.
 */
export function waitFor<E extends ServerEventName>(
  socket: TestSocket,
  event: E,
  predicate: (payload: ServerEventPayload<E>) => boolean = () => true,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<ServerEventPayload<E>> {
  return new Promise((resolve, reject) => {
    const schema: z.ZodType = SERVER_EVENTS[event].payload;
    const listener = (payload: unknown) => {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        cleanup();
        reject(new Error(`„${event}“ verletzt das Payload-Schema: ${JSON.stringify(payload)}`));
        return;
      }
      const typed = parsed.data as ServerEventPayload<E>;
      if (!predicate(typed)) return;
      cleanup();
      resolve(typed);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`„${event}“ nicht innerhalb von ${timeoutMs} ms empfangen`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      untyped(socket).off(event, listener);
    };
    untyped(socket).on(event, listener);
  });
}

/** Wartet auf das Trennen und liefert den Grund (z. B. „io server disconnect“, „transport close“). */
export function waitForDisconnect(socket: TestSocket, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    if (socket.disconnected && !socket.active) {
      resolve("already disconnected");
      return;
    }
    const timer = setTimeout(() => {
      socket.off("disconnect", onDisconnect);
      reject(new Error(`Socket nicht innerhalb von ${timeoutMs} ms getrennt`));
    }, timeoutMs);
    const onDisconnect = (reason: string) => {
      clearTimeout(timer);
      resolve(reason);
    };
    socket.once("disconnect", onDisconnect);
  });
}

export interface ConnectOptions {
  /** Basis-URL des Servers, z. B. `http://127.0.0.1:4130`. */
  url: string;
  /** Ticket; `null` = kein `ticket` im auth-Objekt. */
  ticket: string | null;
  /** Standard: `PROTOCOL_VERSION`; `null` = weglassen. */
  protocolVersion?: number | null;
  /** Komplettes auth-Objekt (ersetzt ticket/protocolVersion). */
  auth?: Record<string, unknown>;
  /** Wert des Origin-Headers; `null` = ohne Origin. */
  origin: string | null;
  /** Weitere Header (z. B. `sec-fetch-site`, simulierte Client-IP). */
  headers?: Record<string, string>;
  /** Standard: nur WebSocket. */
  transports?: Array<"websocket" | "polling">;
  timeoutMs?: number;
}

export interface ConnectFailure {
  /** `data.code` aus `connect_error` (Middleware) oder `null` bei Transportfehlern (z. B. Origin-Ablehnung). */
  code: ErrorCode | null;
  retryAfterMs: number | undefined;
  message: string;
}

export type ConnectResult = { ok: true; socket: TestSocket } | { ok: false; failure: ConnectFailure };

const connectErrorDataSchema = z.object({ code: errorCodeSchema, retryAfterMs: z.number().optional() });

function toFailure(error: Error & { data?: unknown }): ConnectFailure {
  const data = connectErrorDataSchema.safeParse(error.data);
  return {
    code: data.success ? data.data.code : null,
    retryAfterMs: data.success ? data.data.retryAfterMs : undefined,
    message: error.message,
  };
}

/** Verbindet oder liefert den Fehler (`connect_error`) – ohne Wiederholungsversuche. */
export function tryConnect(options: ConnectOptions): Promise<ConnectResult> {
  const auth: Record<string, unknown> = options.auth ?? {};
  if (options.auth === undefined) {
    if (options.ticket !== null) auth.ticket = options.ticket;
    const protocolVersion = options.protocolVersion === undefined ? PROTOCOL_VERSION : options.protocolVersion;
    if (protocolVersion !== null) auth.protocolVersion = protocolVersion;
  }
  const extraHeaders: Record<string, string> = { ...options.headers };
  if (options.origin !== null) extraHeaders.origin = options.origin;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const socket: TestSocket = io(options.url, {
    path: SOCKET_PATH,
    transports: options.transports ?? ["websocket"],
    auth,
    extraHeaders,
    reconnection: false,
    forceNew: true,
    timeout: timeoutMs,
  });
  return new Promise((resolve) => {
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve({ ok: true, socket });
    };
    const onError = (error: Error & { data?: unknown }) => {
      cleanup();
      socket.disconnect();
      resolve({ ok: false, failure: toFailure(error) });
    };
    socket.on("connect", onConnect);
    socket.on("connect_error", onError);
  });
}

/** Empfangenes Server-Event. */
export interface ReceivedEvent {
  event: string;
  payload: unknown;
  /** Empfangszeit (Client-Uhr, ms). */
  at: number;
}

/** Verbundener Test-Client. */
export interface TestClient {
  readonly socket: TestSocket;
  readonly guestId: string;
  /** Simulierte Client-IP (vertrauenswürdiger Test-Header). */
  readonly ip: string;
  /** Alle empfangenen Server-Events in Reihenfolge. */
  readonly received: ReceivedEvent[];
  /** Verstöße gegen Server-Event-Schemas oder Invariante 4 – muss leer bleiben. */
  readonly contractViolations: string[];
  emit<E extends ClientEventName>(
    event: E,
    payload: ClientEventPayloadInput<E>,
    timeoutMs?: number,
  ): Promise<AckResponse<ClientEventAckData<E>>>;
  waitFor<E extends ServerEventName>(
    event: E,
    predicate?: (payload: ServerEventPayload<E>) => boolean,
    timeoutMs?: number,
  ): Promise<ServerEventPayload<E>>;
  /** Trennt den Client (idempotent). */
  close(): void;
}

function isServerEventName(event: string): event is ServerEventName {
  return Object.hasOwn(SERVER_EVENTS, event);
}

/** Umhüllt einen verbundenen Socket und prüft jedes empfangene Server-Event. */
export function createTestClient(socket: TestSocket, guestId: string, ip: string): TestClient {
  const received: ReceivedEvent[] = [];
  const contractViolations: string[] = [];
  socket.onAny((event: string, ...args: unknown[]) => {
    const payload = args[0];
    received.push({ event, payload, at: Date.now() });
    if (!isServerEventName(event)) {
      contractViolations.push(`unbekanntes Server-Event „${event}“`);
      return;
    }
    if (args.length !== 1) contractViolations.push(`„${event}“ mit ${args.length} Argumenten`);
    const schema: z.ZodType = SERVER_EVENTS[event].payload;
    if (!schema.safeParse(payload).success) contractViolations.push(`„${event}“ verletzt das Payload-Schema`);
    const leaks = findKeysDeep(payload, CLIENT_FORBIDDEN_KEYS);
    if (leaks.length > 0) contractViolations.push(`„${event}“ enthält ${leaks.join(", ")}`);
  });
  return {
    socket,
    guestId,
    ip,
    received,
    contractViolations,
    emit: (event, payload, timeoutMs) => emitWithAck(socket, event, payload, timeoutMs),
    waitFor: (event, predicate, timeoutMs) => waitFor(socket, event, predicate, timeoutMs),
    close() {
      socket.disconnect();
    },
  };
}
