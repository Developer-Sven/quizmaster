/**
 * Messwerte des Lasttests: Stichproben je Kennzahl (Reservoir mit fester Obergrenze, damit lange Läufe den
 * Speicher nicht sprengen), Zähler, Perzentile und das Zusammenführen der Ergebnisse mehrerer Prozesse.
 */

/** Höchstens so viele Stichproben je Kennzahl und Prozess (Reservoir-Sampling darüber). */
export const MAX_SAMPLES = 50_000;

export interface SampleSet {
  /** Stichproben (ms). */
  values: number[];
  /** Anzahl aller Beobachtungen (auch die verworfenen). */
  count: number;
  /** Summe aller Beobachtungen (für den Mittelwert). */
  sum: number;
  max: number;
}

export function emptySamples(): SampleSet {
  return { values: [], count: 0, sum: 0, max: 0 };
}

/** Fügt eine Beobachtung hinzu (Algorithmus R, `random` für Tests ersetzbar). */
export function observe(set: SampleSet, value: number, random: () => number = Math.random): void {
  if (!Number.isFinite(value)) return;
  set.count += 1;
  set.sum += value;
  if (value > set.max) set.max = value;
  if (set.values.length < MAX_SAMPLES) {
    set.values.push(value);
    return;
  }
  const slot = Math.floor(random() * set.count);
  if (slot < MAX_SAMPLES) set.values[slot] = value;
}

/** Perzentil (0–100) per linearer Interpolation über die sortierten Stichproben. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const a = sorted[low] ?? 0;
  const b = sorted[high] ?? a;
  return a + (b - a) * (rank - low);
}

export interface Summary {
  count: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function summarize(set: SampleSet): Summary {
  const sorted = [...set.values].sort((a, b) => a - b);
  return {
    count: set.count,
    mean: set.count === 0 ? null : set.sum / set.count,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: set.count === 0 ? null : set.max,
  };
}

/** Führt die Stichproben mehrerer Prozesse zusammen (gewichtet nach ihrer Beobachtungszahl). */
export function mergeSamples(sets: readonly SampleSet[]): SampleSet {
  const merged = emptySamples();
  for (const set of sets) {
    merged.count += set.count;
    merged.sum += set.sum;
    merged.max = Math.max(merged.max, set.max);
  }
  // Jede Teilmenge trägt gemäß ihrem Anteil an allen Beobachtungen bei (Reservoirs sind gleichverteilt).
  for (const set of sets) {
    if (set.values.length === 0 || merged.count === 0) continue;
    const share = Math.min(set.values.length, Math.round((MAX_SAMPLES * set.count) / merged.count));
    const step = set.values.length / Math.max(1, share);
    for (let index = 0; index < share; index++) {
      const value = set.values[Math.floor(index * step)];
      if (value !== undefined) merged.values.push(value);
    }
  }
  return merged;
}

/** Benannte Stichprobenmengen und Zähler eines Prozesses (über IPC serialisierbar). */
export interface WorkerStats {
  samples: Record<string, SampleSet>;
  counters: Record<string, number>;
}

export function emptyStats(): WorkerStats {
  return { samples: {}, counters: {} };
}

export function record(stats: WorkerStats, name: string, value: number): void {
  let set = stats.samples[name];
  if (set === undefined) {
    set = emptySamples();
    stats.samples[name] = set;
  }
  observe(set, value);
}

export function increment(stats: WorkerStats, name: string, by = 1): void {
  stats.counters[name] = (stats.counters[name] ?? 0) + by;
}

export function mergeStats(all: readonly WorkerStats[]): WorkerStats {
  const result = emptyStats();
  const names = new Set(all.flatMap((stats) => Object.keys(stats.samples)));
  for (const name of names) {
    result.samples[name] = mergeSamples(all.flatMap((stats) => (stats.samples[name] ? [stats.samples[name]] : [])));
  }
  for (const stats of all) {
    for (const [name, value] of Object.entries(stats.counters))
      result.counters[name] = (result.counters[name] ?? 0) + value;
  }
  return result;
}

/** „12,3“ (deutsche Notation) oder „–“. */
export function ms(value: number | null, digits = 1): string {
  return value === null ? "–" : value.toFixed(digits).replace(".", ",");
}
