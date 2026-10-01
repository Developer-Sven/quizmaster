/**
 * Bewertung eines Lasttests: Einordnung der Zähler der Generatoren (`ok:<event>`, `error:<event>:<code>`,
 * `timeout:<event>`, `connect_error:<code>`, `disconnect:<grund>`, `state_timeout:<kennzahl>`, `sockets`) in
 * Versuche, Ablehnungen und Serverfehler sowie die Gründe für „nicht gesund“.
 */

/** Zähler, die eine Ablehnung bzw. einen Abbruch bedeuten (auch fachliche Ablehnungen). */
const REJECTION = /^(error|timeout|connect_error|disconnect|state_timeout):/;

/**
 * Codes, die auf einen Serverfehler hindeuten (nicht auf eine fachliche Ablehnung). Eventnamen enthalten selbst
 * einen Doppelpunkt (`error:lobby:create:INTERNAL`) – der Code ist daher immer das letzte Segment.
 */
export const SERVER_FAULT =
  /^(?:timeout|connect_error|disconnect|state_timeout):|^error:.+:(?:INTERNAL|SERVER_BUSY|UNGUELTIG)$/;

/** Ist der Zähler ein Serverfehler (Zeitüberschreitung, Verbindungsfehler, INTERNAL/SERVER_BUSY/ungültiges Ack)? */
export function isServerFault(counter: string): boolean {
  return SERVER_FAULT.test(counter);
}

export interface CounterSummary {
  /** Alle Versuche: Acks (ok/Fehler/Timeout), aufgebaute Sockets und Verbindungsfehler. */
  attempts: number;
  /** Ablehnungen und Abbrüche aller Art. */
  rejected: number;
  /** Davon Serverfehler. */
  faults: number;
  errorRate: number;
  serverErrorRate: number;
}

function sum(counters: Readonly<Record<string, number>>, include: (name: string) => boolean): number {
  return Object.entries(counters)
    .filter(([name]) => include(name))
    .reduce((total, [, value]) => total + value, 0);
}

export function summarizeCounters(counters: Readonly<Record<string, number>>): CounterSummary {
  const attempts =
    sum(counters, (name) => name.startsWith("ok:") || name.startsWith("error:") || name.startsWith("timeout:")) +
    (counters.sockets ?? 0) +
    sum(counters, (name) => name.startsWith("connect_error:"));
  const rejected = sum(counters, (name) => REJECTION.test(name));
  const faults = sum(counters, isServerFault);
  return {
    attempts,
    rejected,
    faults,
    errorRate: attempts === 0 ? 0 : rejected / attempts,
    serverErrorRate: attempts === 0 ? 0 : faults / attempts,
  };
}

export interface HealthInput {
  /** Höchster Event-Loop-p99 (ms). */
  maxP99Ms: number;
  /** Anteil der 5-s-Fenster mit p99 ≤ 50 ms (`null` = unbekannt). */
  fastWindows: number | null;
  /** DB-Ping p95 (ms). */
  dbPingP95Ms: number | null;
  /** Mongo-Fehler laut /metrics im Lauf (`null` = unbekannt). */
  mongoErrors: number | null;
  serverErrorRate: number;
  /** War der Lastabwurf aktiv? */
  overloaded: boolean;
  /** Acks mit `INTERNAL` laut /metrics im Lauf (`null` = unbekannt). */
  internalAcks: number | null;
}

/** Gründe für „nicht gesund“ (leer = gesund für den nächsten Lastschritt). */
export function healthReasons(input: HealthInput, format: (value: number | null, digits?: number) => string): string[] {
  const reasons: string[] = [];
  if (input.maxP99Ms > 200) reasons.push(`Event-Loop p99 bis ${format(input.maxP99Ms)} ms (> 200 ms, Lastabwurf)`);
  if (input.fastWindows !== null && input.fastWindows < 0.95) {
    reasons.push(`nur ${Math.round(input.fastWindows * 100)} % der Fenster mit p99 ≤ 50 ms`);
  }
  if ((input.dbPingP95Ms ?? 0) > 100) reasons.push(`DB-Ping p95 ${format(input.dbPingP95Ms)} ms`);
  if ((input.mongoErrors ?? 0) > 0) reasons.push(`${input.mongoErrors} Mongo-Fehler`);
  if (input.serverErrorRate > 0.01) reasons.push(`Serverfehlerquote ${format(input.serverErrorRate * 100, 2)} %`);
  // Server-seitig gezählt (auch Acks, die die Generatoren nicht mehr erreichten) – jeder INTERNAL ist ein Fehler.
  if ((input.internalAcks ?? 0) > 0) reasons.push(`${input.internalAcks} INTERNAL-Acks laut /metrics`);
  if (input.overloaded) reasons.push("Lastabwurf war aktiv");
  return reasons;
}
