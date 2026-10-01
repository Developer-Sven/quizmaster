/**
 * Fakes für Unit-Tests der Event-Pipeline ohne Netzwerk: ein Socket, der nur das bietet, was Registry und
 * Verstoß-Tracker nutzen (`id`, `data`, `onAny`, `connected`, `disconnect`), und Hilfen zum Auslesen von
 * Metriken.
 */
import { randomUUID } from "node:crypto";
import type { AckResponse } from "@quizmaster/shared";
import type { RealtimeMetrics } from "../../src/metrics.ts";
import type { AppSocket } from "../../src/registry/types.ts";

export interface FakeSocket {
  readonly socket: AppSocket;
  readonly guestId: string;
  /** Anzahl `disconnect(true)`-Aufrufe. */
  readonly disconnects: number;
  /** Nachrichten, die der Server an diesen Socket geschickt hat (`emit`). */
  readonly emitted: Array<{ event: string; payload: unknown }>;
  /** Simuliert ein eingehendes Client-Event (beliebige Argumente). */
  receive(event: unknown, ...args: unknown[]): void;
  /** Sendet ein Event mit Ack-Callback und wartet auf das Ack. */
  call(event: unknown, payload: unknown): Promise<AckResponse<unknown>>;
}

export function createFakeSocket(options: { guestId?: string; ipKey?: string | null } = {}): FakeSocket {
  const guestId = options.guestId ?? randomUUID();
  let listener: ((...args: unknown[]) => void) | undefined;
  let disconnects = 0;
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    id: randomUUID(),
    data: { guestId, ipKey: options.ipKey === undefined ? "ipkey-test" : options.ipKey, ticketTsv: null },
    connected: true,
    onAny(fn: (...args: unknown[]) => void) {
      listener = fn;
      return socket;
    },
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
      return true;
    },
    disconnect() {
      disconnects += 1;
      socket.connected = false;
      return socket;
    },
  };
  const fake: FakeSocket = {
    socket: socket as unknown as AppSocket,
    guestId,
    get disconnects() {
      return disconnects;
    },
    emitted,
    receive(event, ...args) {
      if (listener === undefined) throw new Error("Registry nicht angehängt (attach fehlt)");
      listener(event, ...args);
    },
    call(event, payload) {
      return new Promise((resolve) => {
        fake.receive(event, payload, resolve);
      });
    },
  };
  return fake;
}

/** Summe eines Zählers/Gauges (optional nur Einträge mit passenden Labels). */
export async function metricValue(
  metrics: RealtimeMetrics,
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const metric = metrics.registry.getSingleMetric(name);
  if (metric === undefined) throw new Error(`Metrik ${name} fehlt`);
  const { values } = await metric.get();
  return values
    .filter((entry) => Object.entries(labels).every(([key, value]) => entry.labels[key] === value))
    .reduce((sum, entry) => sum + entry.value, 0);
}

/** Wartet, bis `condition` wahr ist (Polling), sonst Fehler nach `timeoutMs`. */
export async function eventually(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`Bedingung nicht innerhalb von ${timeoutMs} ms erfüllt`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
