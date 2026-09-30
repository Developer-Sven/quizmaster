/**
 * `content:dedupe` (docs/08 §8): Dubletten innerhalb und zwischen Kategorien –
 * - exakt: gleiche Frage (Vergleichsform) und gleiches Bild,
 * - ähnlich: Trigramm-Jaccard ≥ 0,8,
 * - gleicher Fakt: gleiche richtige Antwort + ähnliche Frage (bzw. gleiche Flagge),
 * - umgedreht: Antwort A steht in Frage B und Antwort B in Frage A.
 *
 * Performance (22.472 Fragen): Ähnlichkeit per Präfix-Filter (AllPairs/PPJoin) statt aller n² Paare –
 * Trigramme nach globaler Seltenheit sortiert, nur Kandidaten mit gemeinsamem seltenem Trigramm im
 * Präfix werden exakt nachgerechnet. Das Ergebnis ist exakt (kein Näherungsverfahren).
 */
import type { LoadedQuestion } from "./load.ts";
import { containsPhrase, normalizeText } from "./text.ts";

export const DUPLICATE_KINDS = ["exact", "similar", "same_fact", "reversed"] as const;
export type DuplicateKind = (typeof DUPLICATE_KINDS)[number];

export const DUPLICATE_KIND_LABELS: Record<DuplicateKind, string> = {
  exact: "exakt",
  similar: "ähnlich",
  same_fact: "gleicher Fakt",
  reversed: "umgedreht",
};

export interface DuplicatePair {
  kind: DuplicateKind;
  a: LoadedQuestion;
  b: LoadedQuestion;
  /** Trigramm-Jaccard der Fragetexte (0–1). */
  similarity: number;
  crossCategory: boolean;
}

export interface DedupeOptions {
  /** Ähnlich ab (Standard 0,8). */
  similarThreshold?: number;
  /** „Gleicher Fakt“: gleiche Antwort und Frage-Ähnlichkeit ab (Standard 0,5). */
  sameFactThreshold?: number;
  /** Nur Paare, an denen diese Kategorie beteiligt ist. */
  category?: string;
}

export interface DedupeResult {
  questions: number;
  pairs: DuplicatePair[];
  counts: Record<DuplicateKind, { within: number; across: number }>;
}

interface Prepared {
  question: LoadedQuestion;
  prompt: string;
  answer: string;
  media: string;
  /** Trigramm-IDs aufsteigend nach ID (für den Merge beim Nachrechnen). */
  byId: Int32Array;
  /** Trigramm-IDs nach globaler Seltenheit (für den Präfix). */
  byRarity: Int32Array;
}

const KIND_PRIORITY: Record<DuplicateKind, number> = { exact: 0, similar: 1, same_fact: 2, reversed: 3 };
/** Gleitkomma-Toleranz an Schwellen (0,8 · 60 = 48,000000000000004 → sonst ⌈…⌉ = 49). */
const EPSILON = 1e-9;
const ceilSafe = (value: number) => Math.ceil(value - EPSILON);

/** Längste Antwort (in Wörtern), die in Fragetexten gesucht wird. */
const MAX_ANSWER_WORDS = 6;
/** Kürzere Antworten sind für „umgedreht“ zu unspezifisch. */
const MIN_REVERSED_ANSWER_LENGTH = 3;

function trigramList(normalized: string): string[] {
  const chars = Array.from(` ${normalized} `);
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= chars.length; index++) grams.add(chars.slice(index, index + 3).join(""));
  return [...grams];
}

function prepare(questions: readonly LoadedQuestion[]): Prepared[] {
  const ids = new Map<string, number>();
  const frequency: number[] = [];
  const raw = questions.map((question) => {
    const prompt = normalizeText(question.entry.prompt);
    const tokens = trigramList(prompt).map((gram) => {
      let id = ids.get(gram);
      if (id === undefined) {
        id = ids.size;
        ids.set(gram, id);
        frequency.push(0);
      }
      frequency[id] = (frequency[id] ?? 0) + 1;
      return id;
    });
    return { question, prompt, tokens };
  });
  return raw.map(({ question, prompt, tokens }) => {
    const byId = Int32Array.from(tokens).sort();
    const byRarity = Int32Array.from(tokens).sort((a, b) => (frequency[a] ?? 0) - (frequency[b] ?? 0) || a - b);
    return {
      question,
      prompt,
      answer: normalizeText(question.entry.answers[0]),
      media: question.entry.media?.code ?? "",
      byId,
      byRarity,
    };
  });
}

/** |A ∩ B| zweier aufsteigend sortierter ID-Listen. */
function intersectionSize(a: Int32Array, b: Int32Array): number {
  let i = 0;
  let j = 0;
  let count = 0;
  while (i < a.length && j < b.length) {
    const x = a[i] ?? 0;
    const y = b[j] ?? 0;
    if (x === y) {
      count += 1;
      i += 1;
      j += 1;
    } else if (x < y) i += 1;
    else j += 1;
  }
  return count;
}

export function jaccard(a: Int32Array, b: Int32Array): number {
  if (a.length === 0 && b.length === 0) return 1;
  const shared = intersectionSize(a, b);
  return shared / (a.length + b.length - shared);
}

class PairRegistry {
  readonly pairs = new Map<string, { kind: DuplicateKind; i: number; j: number; similarity: number }>();

  add(kind: DuplicateKind, first: number, second: number, similarity: number): void {
    if (first === second) return;
    const i = Math.min(first, second);
    const j = Math.max(first, second);
    const key = `${i}:${j}`;
    const existing = this.pairs.get(key);
    if (existing && KIND_PRIORITY[existing.kind] <= KIND_PRIORITY[kind]) return;
    this.pairs.set(key, { kind, i, j, similarity });
  }

  has(first: number, second: number): boolean {
    return this.pairs.has(`${Math.min(first, second)}:${Math.max(first, second)}`);
  }
}

function groupBy(items: readonly Prepared[], key: (item: Prepared) => string): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  items.forEach((item, index) => {
    const value = key(item);
    const list = groups.get(value);
    if (list) list.push(index);
    else groups.set(value, [index]);
  });
  return groups;
}

function findExact(items: readonly Prepared[], registry: PairRegistry): void {
  for (const group of groupBy(items, (item) => `${item.prompt}#${item.media}`).values()) {
    for (let x = 0; x < group.length; x++) {
      for (let y = x + 1; y < group.length; y++) registry.add("exact", group[x] ?? 0, group[y] ?? 0, 1);
    }
  }
}

/**
 * Präfix- und Positionsfilter (PPJoin): alle Paare mit Jaccard ≥ threshold, exakt und ohne
 * n²-Vergleich. Ein Paar kann nur ähnlich sein, wenn es im Präfix (seltenste Trigramme) ein Trigramm
 * teilt UND die restlichen Positionen die nötige Überlappung α = ⌈t/(1+t)·(|x|+|y|)⌉ noch erreichen
 * können – alle anderen Kandidaten fallen weg, bevor exakt nachgerechnet wird.
 */
function findSimilar(items: readonly Prepared[], threshold: number, registry: PairRegistry): void {
  const sizeOf = (index: number) => items[index]?.byId.length ?? 0;
  const order = items.map((_, index) => index).sort((a, b) => sizeOf(a) - sizeOf(b));
  /** Token → flache Liste [Datensatz, Position, Datensatz, Position, …] (nach Größe aufsteigend). */
  const index = new Map<number, number[]>();
  const overlap = new Int32Array(items.length);
  const stamp = new Int32Array(items.length).fill(-1);
  const candidates: number[] = [];
  for (const x of order) {
    const item = items[x];
    if (item === undefined) continue;
    const size = item.byRarity.length;
    const prefix = Math.min(size, size - ceilSafe(threshold * size) + 1);
    const minSize = ceilSafe(threshold * size);
    candidates.length = 0;
    for (let i = 0; i < prefix; i++) {
      const postings = index.get(item.byRarity[i] ?? 0);
      if (postings === undefined) continue;
      // Nach Größe sortiert → zu kleine Datensätze per Binärsuche überspringen.
      let low = 0;
      let high = postings.length / 2;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (sizeOf(postings[middle * 2] ?? 0) < minSize) low = middle + 1;
        else high = middle;
      }
      for (let k = low * 2; k < postings.length; k += 2) {
        const y = postings[k] ?? 0;
        const j = postings[k + 1] ?? 0;
        if (stamp[y] !== x) {
          stamp[y] = x;
          overlap[y] = 0;
          candidates.push(y);
        }
        const current = overlap[y] ?? 0;
        if (current < 0) continue;
        const otherSize = sizeOf(y);
        const alpha = ceilSafe((threshold / (1 + threshold)) * (size + otherSize));
        const upperBound = current + 1 + Math.min(size - i - 1, otherSize - j - 1);
        overlap[y] = upperBound >= alpha ? current + 1 : -1;
      }
    }
    for (const y of candidates) {
      const other = items[y];
      if ((overlap[y] ?? 0) <= 0 || other === undefined || other.media !== item.media) continue;
      const similarity = jaccard(item.byId, other.byId);
      if (similarity >= threshold - EPSILON) registry.add("similar", x, y, similarity);
    }
    for (let i = 0; i < prefix; i++) {
      const token = item.byRarity[i] ?? 0;
      const postings = index.get(token);
      if (postings) postings.push(x, i);
      else index.set(token, [x, i]);
    }
  }
}

function findSameFact(items: readonly Prepared[], threshold: number, registry: PairRegistry): void {
  for (const group of groupBy(items, (item) => `${item.answer}#${item.media}`).values()) {
    if (group.length < 2) continue;
    for (let x = 0; x < group.length; x++) {
      for (let y = x + 1; y < group.length; y++) {
        const i = group[x] ?? 0;
        const j = group[y] ?? 0;
        if (registry.has(i, j)) continue;
        const a = items[i];
        const b = items[j];
        if (a === undefined || b === undefined || a.answer === "") continue;
        const similarity = jaccard(a.byId, b.byId);
        // Gleiche Flagge mit gleicher Antwort ist immer derselbe Fakt – der Fragetext ist dort generisch.
        if (a.media !== "" || similarity >= threshold - EPSILON) registry.add("same_fact", i, j, similarity);
      }
    }
  }
}

function findReversed(items: readonly Prepared[], registry: PairRegistry): void {
  const byAnswer = new Map<string, number[]>();
  items.forEach((item, index) => {
    if (item.answer.length < MIN_REVERSED_ANSWER_LENGTH) return;
    const list = byAnswer.get(item.answer);
    if (list) list.push(index);
    else byAnswer.set(item.answer, [index]);
  });
  items.forEach((item, p) => {
    const words = item.prompt.split(" ");
    const seen = new Set<string>();
    for (let start = 0; start < words.length; start++) {
      for (let length = 1; length <= MAX_ANSWER_WORDS && start + length <= words.length; length++) {
        const phrase = words.slice(start, start + length).join(" ");
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        for (const q of byAnswer.get(phrase) ?? []) {
          const other = items[q];
          if (q === p || other === undefined || other.answer === item.answer || registry.has(p, q)) continue;
          if (item.answer.length >= MIN_REVERSED_ANSWER_LENGTH && containsPhrase(other.prompt, item.answer)) {
            registry.add("reversed", p, q, jaccard(item.byId, other.byId));
          }
        }
      }
    }
  });
}

export function findDuplicates(questions: readonly LoadedQuestion[], options: DedupeOptions = {}): DedupeResult {
  const items = prepare(questions);
  const registry = new PairRegistry();
  findExact(items, registry);
  findSimilar(items, options.similarThreshold ?? 0.8, registry);
  findSameFact(items, options.sameFactThreshold ?? 0.5, registry);
  findReversed(items, registry);

  const counts = Object.fromEntries(
    DUPLICATE_KINDS.map((kind) => [kind, { within: 0, across: 0 }]),
  ) as DedupeResult["counts"];
  const pairs: DuplicatePair[] = [];
  for (const { kind, i, j, similarity } of registry.pairs.values()) {
    const a = items[i]?.question;
    const b = items[j]?.question;
    if (a === undefined || b === undefined) continue;
    if (options.category !== undefined && a.category !== options.category && b.category !== options.category) continue;
    const crossCategory = a.category !== b.category;
    counts[kind][crossCategory ? "across" : "within"] += 1;
    pairs.push({ kind, a, b, similarity, crossCategory });
  }
  pairs.sort((x, y) => KIND_PRIORITY[x.kind] - KIND_PRIORITY[y.kind] || y.similarity - x.similarity);
  return { questions: questions.length, pairs, counts };
}
