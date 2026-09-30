/**
 * Zufall für die Engine (docs/02: „kein Zufall ohne übergebenen RNG“). Die Engine zieht jeden Zufall über
 * `ctx.rng`: in Produktion `createCryptoRng()` (`node:crypto` randomInt, Subpath
 * „@quizmaster/game-engine/crypto-rng“), in Tests `createSeededRng(seed)` für deterministische Verläufe.
 * Dieses Modul hat keine `node:`-Importe und ist daher auch clientfähig.
 */

/** Zufallsquelle: gleichverteilte ganze Zahl in `[0, maxExclusive)`. */
export interface Rng {
  int(maxExclusive: number): number;
}

/** Größte unterstützte Obergrenze (2^32) – reicht für Mischungen, IDs und Auswahl. */
export const RNG_MAX_RANGE = 2 ** 32;

/** Prüft die Obergrenze eines `int`-Aufrufs (ganze Zahl in `[1, 2^32]`). */
export function assertRngRange(maxExclusive: number): void {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > RNG_MAX_RANGE) {
    throw new RangeError(`maxExclusive muss eine ganze Zahl in [1, 2^32] sein (erhalten: ${maxExclusive})`);
  }
}

/** splitmix32 – verteilt einen 32-Bit-Startwert auf gut gemischte Zustandswörter. */
function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) | 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** Hash eines Seeds (Zahl oder Text) auf 32 Bit (FNV-1a-Variante). */
function hashSeed(seed: number | string): number {
  const text = typeof seed === "number" ? `n:${seed}` : `s:${seed}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return hash >>> 0;
}

/** sfc32 (Small Fast Counter) – schneller 128-Bit-PRNG, liefert vorzeichenlose 32-Bit-Werte. */
function sfc32(seed: number | string): () => number {
  const init = splitmix32(hashSeed(seed));
  let a = init();
  let b = init();
  let c = init();
  let d = init();
  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  // Aufwärmen: die ersten Ausgaben hängen noch stark am Startzustand.
  for (let i = 0; i < 12; i++) next();
  return next;
}

/**
 * Gleichverteilte ganze Zahl aus einer 32-Bit-Quelle – Ablehnungsmethode ohne Modulo-Verzerrung
 * (nur Werte unterhalb des größten Vielfachen von `maxExclusive` zählen).
 */
function uniformInt(next32: () => number, maxExclusive: number): number {
  assertRngRange(maxExclusive);
  if (maxExclusive === RNG_MAX_RANGE) return next32();
  const limit = RNG_MAX_RANGE - (RNG_MAX_RANGE % maxExclusive);
  for (;;) {
    const value = next32();
    if (value < limit) return value % maxExclusive;
  }
}

/** Deterministischer RNG für Tests, Simulationen und Replays: gleicher Seed → gleiche Folge. */
export function createSeededRng(seed: number | string): Rng {
  const next32 = sfc32(seed);
  return { int: (maxExclusive) => uniformInt(next32, maxExclusive) };
}

/** Mischt eine Kopie gleichverteilt (Fisher–Yates); die Eingabe bleibt unverändert. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const current = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = current;
  }
  return copy;
}

/** Ein gleichverteilt gewähltes Element; wirft bei leerer Liste. */
export function pickOne<T>(items: readonly T[], rng: Rng): T {
  if (items.length === 0) throw new RangeError("pickOne: leere Liste");
  return items[rng.int(items.length)] as T;
}

/** Gleichverteilte Zahl in [0, 1) mit 32 Bit Auflösung. */
function unitInterval(rng: Rng): number {
  return rng.int(RNG_MAX_RANGE) / RNG_MAX_RANGE;
}

/** true mit Wahrscheinlichkeit `probability` (0 … 1). */
export function chance(probability: number, rng: Rng): boolean {
  if (!(probability > 0)) return false;
  if (probability >= 1) return true;
  return unitInterval(rng) < probability;
}

/**
 * Index gemäß Gewichten (≥ 0, beliebige Summe). Einträge mit Gewicht 0 werden nie gewählt, außer alle
 * Gewichte sind 0 – dann gleichverteilt. Wirft bei leerer Liste oder negativen/nicht endlichen Gewichten.
 */
export function weightedIndex(weights: readonly number[], rng: Rng): number {
  if (weights.length === 0) throw new RangeError("weightedIndex: leere Liste");
  let total = 0;
  let lastPositive = -1;
  weights.forEach((weight, index) => {
    if (!Number.isFinite(weight) || weight < 0) throw new RangeError(`Ungültiges Gewicht: ${weight}`);
    total += weight;
    if (weight > 0) lastPositive = index;
  });
  if (total === 0) return rng.int(weights.length);
  const ticket = unitInterval(rng) * total;
  let cumulative = 0;
  for (let index = 0; index < weights.length; index++) {
    const weight = weights[index] ?? 0;
    if (weight === 0) continue;
    cumulative += weight;
    if (ticket < cumulative) return index;
  }
  // Rundungsrest der Gleitkommasumme: letzter Eintrag mit positivem Gewicht.
  return lastPositive;
}

/** Alphabet öffentlicher Zufalls-IDs (Teilmenge von `PUBLIC_ID_REGEX` aus shared). */
export const RANDOM_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Zufällige ID aus `[A-Za-z0-9]` (Standard 16 Zeichen ≈ 95 Bit). */
export function randomId(rng: Rng, length = 16): string {
  if (!Number.isInteger(length) || length < 1 || length > 64) {
    throw new RangeError(`ID-Länge muss 1–64 sein (erhalten: ${length})`);
  }
  let id = "";
  for (let i = 0; i < length; i++) {
    id += RANDOM_ID_ALPHABET[rng.int(RANDOM_ID_ALPHABET.length)];
  }
  return id;
}

/** Zufällige ID, die in `taken` noch nicht vorkommt (Kollisionen sind praktisch ausgeschlossen, aber geprüft). */
export function uniqueRandomId(rng: Rng, taken: ReadonlySet<string>, length = 16): string {
  for (;;) {
    const id = randomId(rng, length);
    if (!taken.has(id)) return id;
  }
}
