/**
 * Uhrenabgleich (docs/05 §Uhrenabgleich): Nach dem Verbinden 5× `time:sync` im Abstand von 300 ms,
 * `offset = serverNow − (t0 + rtt / 2)`, Median; alle 60 s, nach einem Reconnect und nach der Rückkehr in
 * den Vordergrund wiederholen (docs/10 §App-Gefühl). Transport und Uhr sind injiziert (testbar).
 */
import { CLOCK_SYNC, clockOffsetSample, medianOffset } from "@quizmaster/shared";

/** Eine Messung: Senden (t0) und Ack-Eingang (t1) in Client-Zeit, `serverNow` aus dem Ack. */
export interface ClockSample {
  t0: number;
  t1: number;
  serverNow: number;
}

/** Median-Offset mehrerer Messungen; `null` ohne gültige Messung. */
export function offsetFromSamples(samples: readonly ClockSample[]): number | null {
  const offsets = samples
    .filter((sample) => Number.isFinite(sample.serverNow) && sample.t1 >= sample.t0)
    .map((sample) => clockOffsetSample(sample.t0, sample.t1, sample.serverNow));
  return offsets.length === 0 ? null : medianOffset(offsets);
}

export interface ClockSyncOptions {
  /** Sendet `time:sync { t0 }` und liefert `serverNow` – oder `null`, wenn kein Ack kam. */
  requestServerTime: (t0: number) => Promise<number | null>;
  /** Neuer Offset (ms) nach einer erfolgreichen Messreihe. */
  onOffset: (offset: number) => void;
  /** Client-Uhr (Standard `Date.now`). */
  now?: () => number;
  /** Warten zwischen den Messungen (Standard `setTimeout`). */
  wait?: (ms: number) => Promise<void>;
  /** Wiederholung (Standard `setInterval`); liefert eine Abmeldung. */
  every?: (ms: number, run: () => void) => () => void;
  samples?: number;
  sampleIntervalMs?: number;
  resyncIntervalMs?: number;
}

export interface ClockSync {
  /** Misst sofort und danach alle 60 s (idempotent). */
  start(): void;
  /** Beendet die Wiederholung; eine laufende Messreihe meldet keinen Offset mehr. */
  stop(): void;
  /** Eine Messreihe jetzt (läuft schon eine, wird sie geteilt). Liefert den Offset oder `null`. */
  syncNow(): Promise<number | null>;
  /** Läuft die Wiederholung? */
  readonly running: boolean;
}

const defaultWait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultEvery = (ms: number, run: () => void) => {
  const handle = setInterval(run, ms);
  return () => clearInterval(handle);
};

export function createClockSync(options: ClockSyncOptions): ClockSync {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultWait;
  const every = options.every ?? defaultEvery;
  const sampleCount = options.samples ?? CLOCK_SYNC.samples;
  const sampleIntervalMs = options.sampleIntervalMs ?? CLOCK_SYNC.sampleIntervalMs;
  const resyncIntervalMs = options.resyncIntervalMs ?? CLOCK_SYNC.resyncIntervalMs;

  let generation = 0;
  let current: Promise<number | null> | null = null;
  let cancelInterval: (() => void) | null = null;

  async function measure(runGeneration: number): Promise<number | null> {
    const samples: ClockSample[] = [];
    for (let index = 0; index < sampleCount; index++) {
      if (index > 0) await wait(sampleIntervalMs);
      if (runGeneration !== generation) return null;
      const t0 = now();
      const serverNow = await options.requestServerTime(t0);
      const t1 = now();
      if (serverNow !== null) samples.push({ t0, t1, serverNow });
    }
    const offset = offsetFromSamples(samples);
    if (offset !== null && runGeneration === generation) options.onOffset(offset);
    return offset;
  }

  function syncNow(): Promise<number | null> {
    if (current) return current;
    const run = measure(generation).finally(() => {
      if (current === run) current = null;
    });
    current = run;
    return run;
  }

  return {
    start() {
      if (cancelInterval) return;
      cancelInterval = every(resyncIntervalMs, () => {
        void syncNow();
      });
      void syncNow();
    },
    stop() {
      generation += 1;
      current = null;
      cancelInterval?.();
      cancelInterval = null;
    },
    syncNow,
    get running() {
      return cancelInterval !== null;
    },
  };
}
