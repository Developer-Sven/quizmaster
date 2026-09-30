/**
 * Transport-Konstanten für Socket.IO und den Uhrenabgleich (docs/05 §Verbindung, §Uhrenabgleich,
 * ADR-028). Als Fabrikfunktionen, damit Aufrufer veränderbare Kopien an Socket.IO übergeben können.
 */

/** Pfad des Realtime-Servers; in Produktion auf derselben Origin geroutet. */
export const SOCKET_PATH = "/socket.io";

/**
 * Server-Optionen (docs/05 §Verbindung 4). Connection State Recovery bleibt aus (Option nicht setzen) –
 * Resync immer über `lobby:resume`. `cors.origin` = APP_ORIGIN-Liste ergänzt der Server selbst.
 */
export function socketServerOptions() {
  return {
    path: SOCKET_PATH,
    serveClient: false,
    maxHttpBufferSize: 8_192,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,
  };
}

/** Client-Optionen: WebSocket zuerst, Long-Polling als Fallback (ADR-028), Backoff bis 5 s. */
export function socketClientOptions() {
  return {
    path: SOCKET_PATH,
    transports: ["websocket", "polling"] as Array<"websocket" | "polling">,
    tryAllTransports: true,
    reconnectionDelayMax: 5_000,
  };
}

/** Uhrenabgleich: 5 Messungen im Abstand von 300 ms, Median; alle 60 s und nach Reconnect wiederholen. */
export const CLOCK_SYNC = {
  samples: 5,
  sampleIntervalMs: 300,
  resyncIntervalMs: 60_000,
} as const;

/**
 * Offset einer Messung: `serverNow − (t0 + rtt / 2)` mit `rtt = t1 − t0` (t0 = Senden, t1 = Ack-Eingang,
 * beides Client-Zeit). Clients rechnen danach mit `Date.now() + offset`.
 */
export function clockOffsetSample(t0: number, t1: number, serverNow: number): number {
  return serverNow - (t0 + (t1 - t0) / 2);
}

/** Median mehrerer Offsets (robust gegen einzelne Ausreißer); leere Liste → 0. */
export function medianOffset(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1] ?? upper;
  return (lower + upper) / 2;
}
