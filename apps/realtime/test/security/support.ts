/**
 * Hilfen der Sicherheits-Suite (docs/06 Phase-4-Checkliste, docs/11 §Sicherheits-Invarianten und
 * Missbrauchstests): eigener Port-Bereich 4510–4519, Server mit den Produktions-Modulen (inkl. Sicherheits-Modul
 * mit kurzen Neustart-Pausen), ein Protokoll ALLER Server→Client-Daten (Events und Acks) für Invariante 4 sowie
 * gültige Beispiel-Payloads je Event.
 */
import { randomUUID } from "node:crypto";
import {
  type AckResponse,
  type ClientEventAckData,
  type ClientEventName,
  type ClientEventPayloadInput,
  PROTOCOL_VERSION,
  RATE_LIMITS,
  type RateLimitRule,
  SOCKET_PATH,
} from "@quizmaster/shared";
import { io } from "socket.io-client";
import { lobbyGameModule } from "../../src/lobby/module.ts";
import { timeSyncModule } from "../../src/registry/time-sync.ts";
import type { RealtimeModule } from "../../src/registry/types.ts";
import { createSecurityModule } from "../../src/services/security-module.ts";
import {
  type ReceivedEvent,
  type StartTestServerOptions,
  startTestServer,
  TEST_IP_HEADER,
  type TestClient,
  type TestServer,
  type TestSocket,
} from "../helpers/index.ts";

/** Port-Bereich der Sicherheits-Suite. */
export const SECURITY_TEST_PORTS = { from: 4510, to: 4519 } as const;

/** Wie `REALTIME_MODULES`, aber mit kurzen Neustart-Pausen der Sicherheits-Watcher (Tests). */
export function securityTestModules(
  options: Parameters<typeof createSecurityModule>[0] = {},
): readonly RealtimeModule[] {
  return [
    timeSyncModule,
    lobbyGameModule,
    createSecurityModule({ watchBackoff: { initialMs: 50, maxMs: 500 }, ...options }),
  ];
}

export function startSecurityServer(options: StartTestServerOptions = {}): Promise<TestServer> {
  return startTestServer({
    timing: "fast",
    ports: SECURITY_TEST_PORTS,
    modules: securityTestModules(),
    ...options,
  });
}

/** Ein empfangenes Datum vom Server: Event-Payload oder Ack. */
export interface ServerDatum {
  kind: "event" | "ack";
  name: string;
  payload: unknown;
}

/** Sammelt Acks eines Test-Clients (Events protokolliert `client.received` bereits). */
export interface AckRecorder {
  readonly acks: ServerDatum[];
  emit<E extends ClientEventName>(
    event: E,
    payload: ClientEventPayloadInput<E>,
    timeoutMs?: number,
  ): Promise<AckResponse<ClientEventAckData<E>>>;
}

export function recordAcks(client: TestClient, sink: ServerDatum[]): AckRecorder {
  return {
    acks: sink,
    async emit(event, payload, timeoutMs) {
      const ack = await client.emit(event, payload, timeoutMs);
      sink.push({ kind: "ack", name: event, payload: ack });
      return ack;
    },
  };
}

/** Alle Server→Client-Daten eines Clients (Events) plus mitgeschnittene Acks. */
export function serverData(client: TestClient, acks: readonly ServerDatum[] = []): ServerDatum[] {
  return [
    ...client.received.map((entry) => ({ kind: "event" as const, name: entry.event, payload: entry.payload })),
    ...acks,
  ];
}

/** Gültige Beispiel-Payloads je Event (Form stimmt; ob die Aktion fachlich passt, prüft der Handler). */
export const VALID_PAYLOADS: { [E in ClientEventName]: ClientEventPayloadInput<E> } = {
  "time:sync": { t0: 1 },
  "lobby:create": { name: "Mia" },
  "lobby:join": { code: "ZZZZZZ", name: "Mia" },
  "lobby:resume": { code: "ZZZZZZ" },
  "lobby:leave": {},
  "lobby:update-settings": { rounds: 3 },
  "lobby:kick": { playerId: "p1" },
  "lobby:rename": { name: "Ben" },
  "lobby:transfer-host": { playerId: "p1" },
  "lobby:suggest-settings": { rounds: 5 },
  "lobby:withdraw-suggestion": {},
  "lobby:accept-suggestion": { id: "s1" },
  "lobby:decline-suggestion": { id: "s1" },
  "lobby:start": {},
  "game:pick": { categoryId: "comics" },
  "game:answer": { questionId: "q1", choice: 1 },
  "game:review": {},
  "game:rematch": {},
  "game:continue": { phase: "reveal" },
  "game:end": {},
  "question:rate": { questionId: "q1", value: 1 },
  "question:report": { questionId: "q1", reason: "falsch" },
  "dev:add-bot": {},
};

/** Zeitfenster-Regeln eines Ziels aus der Tabelle (Invariante 6). */
export function rateRulesFor(target: string): RateLimitRule[] {
  return RATE_LIMITS.filter((rule) => rule.target === target && rule.kind === "rate");
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface EarlyClient {
  readonly socket: TestSocket;
  /** Alle Server-Events ab dem ersten Paket nach dem Verbinden. */
  readonly received: ReceivedEvent[];
  close(): void;
}

/**
 * Verbindet wie der Web-Client: Listener hängen VOR dem Verbindungsaufbau – so ist auch ein Hinweis direkt nach
 * dem Connect (z. B. `notice MAINTENANCE`) sichtbar, den `connectClient` erst nach `connect` mitschneiden würde.
 */
export async function connectEarly(server: TestServer, options: { guestId?: string } = {}): Promise<EarlyClient> {
  const ticket = await server.mintTicket(options.guestId ?? randomUUID());
  const socket: TestSocket = io(server.url, {
    path: SOCKET_PATH,
    transports: ["websocket"],
    auth: { ticket, protocolVersion: PROTOCOL_VERSION },
    extraHeaders: { origin: server.origin, [TEST_IP_HEADER]: server.nextIp() },
    reconnection: false,
    forceNew: true,
    autoConnect: false,
  });
  const received: ReceivedEvent[] = [];
  socket.onAny((event: string, ...args: unknown[]) => {
    received.push({ event, payload: args[0], at: Date.now() });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (error) => reject(error));
    socket.connect();
  });
  return {
    socket,
    received,
    close() {
      socket.disconnect();
    },
  };
}
