/**
 * `/metrics` des Realtime-Servers während des Lasttests (Namen siehe apps/realtime/src/metrics.ts): Prometheus-Text
 * lesen, Zähler-/Histogramm-Differenzen zwischen zwei Abrufen bilden und Quantile aus Histogramm-Buckets schätzen
 * (lineare Interpolation wie `histogram_quantile`).
 */

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/;
const PAIR = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

export function parseProm(text: string): PromSample[] {
  const samples: PromSample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = LINE.exec(line);
    if (match?.[1] === undefined || match[3] === undefined) continue;
    const value = match[3] === "+Inf" ? Number.POSITIVE_INFINITY : Number(match[3]);
    if (Number.isNaN(value)) continue;
    const labels: Record<string, string> = {};
    for (const pair of (match[2] ?? "").matchAll(PAIR)) {
      if (pair[1] !== undefined && pair[2] !== undefined) labels[pair[1]] = pair[2].replace(/\\(.)/g, "$1");
    }
    samples.push({ name: match[1], labels, value });
  }
  return samples;
}

export type LabelMatch = Record<string, string>;

function matches(sample: PromSample, name: string, labels: LabelMatch): boolean {
  return sample.name === name && Object.entries(labels).every(([key, value]) => sample.labels[key] === value);
}

/** Summe aller passenden Serien. */
export function sumOf(samples: readonly PromSample[], name: string, labels: LabelMatch = {}): number {
  return samples.filter((sample) => matches(sample, name, labels)).reduce((sum, sample) => sum + sample.value, 0);
}

/** Wert der ersten passenden Serie oder `null`. */
export function seriesValue(samples: readonly PromSample[], name: string, labels: LabelMatch = {}): number | null {
  return samples.find((sample) => matches(sample, name, labels))?.value ?? null;
}

/** Kumulative Bucket-Zähler eines Histogramms (Summe über alle übrigen Labels), Differenz zu `before`. */
export function bucketCounts(
  after: readonly PromSample[],
  before: readonly PromSample[] | null,
  name: string,
  labels: LabelMatch = {},
): Array<{ le: number; count: number }> {
  const collect = (samples: readonly PromSample[]) => {
    const byLe = new Map<number, number>();
    for (const sample of samples) {
      if (!matches(sample, `${name}_bucket`, labels)) continue;
      const le = sample.labels.le === "+Inf" ? Number.POSITIVE_INFINITY : Number(sample.labels.le);
      byLe.set(le, (byLe.get(le) ?? 0) + sample.value);
    }
    return byLe;
  };
  const end = collect(after);
  const start = before === null ? new Map<number, number>() : collect(before);
  return [...end.entries()]
    .map(([le, count]) => ({ le, count: Math.max(0, count - (start.get(le) ?? 0)) }))
    .sort((a, b) => a.le - b.le);
}

/** Quantil (0–1) aus kumulativen Buckets; `null` ohne Beobachtungen. */
export function histogramQuantile(buckets: ReadonlyArray<{ le: number; count: number }>, q: number): number | null {
  const total = buckets.at(-1)?.count ?? 0;
  if (total === 0) return null;
  const rank = q * total;
  let previousLe = 0;
  let previousCount = 0;
  for (const bucket of buckets) {
    if (bucket.count >= rank) {
      if (!Number.isFinite(bucket.le)) return previousLe;
      const inBucket = bucket.count - previousCount;
      const fraction = inBucket === 0 ? 1 : (rank - previousCount) / inBucket;
      return previousLe + (bucket.le - previousLe) * fraction;
    }
    previousLe = bucket.le;
    previousCount = bucket.count;
  }
  return previousLe;
}

/** Anteil der Beobachtungen ≤ `le` (z. B. „p99 je Fenster ≤ 50 ms“). */
export function fractionAtMost(buckets: ReadonlyArray<{ le: number; count: number }>, le: number): number | null {
  const total = buckets.at(-1)?.count ?? 0;
  if (total === 0) return null;
  const bucket = buckets.find((entry) => Math.abs(entry.le - le) < 1e-9);
  return bucket === undefined ? null : bucket.count / total;
}

export async function scrapeMetrics(base: string, token: string): Promise<PromSample[]> {
  const response = await fetch(new URL("/metrics", base), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`/metrics: HTTP ${response.status}`);
  return parseProm(await response.text());
}
