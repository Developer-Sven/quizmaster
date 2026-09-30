/**
 * Text-Normalisierung für Prüfungen und Dubletten-Suche: NFKC, Kleinbuchstaben, Satzzeichen und
 * Anführungszeichen raus, Leerraum zusammengefasst. Zahlen im deutschen Format („1.000“, „3,14“).
 */

/** Vergleichsform: „Was ist „X“? “ → „was ist x“. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Zeichen-Trigramme der Vergleichsform (mit Leerzeichen an den Rändern), als Menge. */
export function trigrams(text: string): Set<string> {
  const padded = ` ${normalizeText(text)} `;
  const grams = new Set<string>();
  const chars = Array.from(padded);
  for (let index = 0; index + 3 <= chars.length; index++) grams.add(chars.slice(index, index + 3).join(""));
  return grams;
}

/** true, wenn `phrase` (Vergleichsform) als ganze Wortfolge in `text` (Vergleichsform) vorkommt. */
export function containsPhrase(text: string, phrase: string): boolean {
  if (phrase === "") return false;
  return ` ${text} `.includes(` ${phrase} `);
}

const GERMAN_NUMBER = /^[-−]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?/;

/**
 * Führende Zahl im deutschen Format („1.001 PS“ → 1001, „0,25“ → 0.25, „-3“ → -3); `null`, wenn die
 * Antwort nicht mit einer Zahl beginnt. Für `displayOrder: "asc"`.
 */
export function parseLeadingGermanNumber(text: string): number | null {
  const match = GERMAN_NUMBER.exec(text.trim());
  if (!match) return null;
  const normalized = match[0].replace("−", "-").replaceAll(".", "").replace(",", ".");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Verbotene Sammelantworten (docs/08 §6): „Alle genannten“, „Keine davon“, „Keine der Antworten“,
 * „Alle sind richtig“ … Einzelwörter wie „Keine“ (z. B. Anzahl Monde) bleiben erlaubt.
 */
const FORBIDDEN_ANSWER_PATTERNS: readonly RegExp[] = [
  /^(?:alle|keine|keiner|nichts)(?: der| von den)?(?: oben)? genannt\p{L}*(?: antwort\p{L}*| optionen| möglichkeiten)?(?: sind richtig| ist richtig)?$/u,
  /^(?:alle|keine|nichts) davon(?: ist richtig| sind richtig| trifft zu| treffen zu)?$/u,
  /^(?:alle|keine)(?: der)? antwort\p{L}*(?: sind richtig| ist richtig| richtig| stimmen| stimmt)?$/u,
  /^(?:alle|keine|beide) (?:sind |ist )?richtig$/u,
];

export function isForbiddenAnswer(answer: string): boolean {
  const normalized = normalizeText(answer);
  return FORBIDDEN_ANSWER_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Leerraum-Probleme: führend/abschließend, doppelt oder Tab/Zeilenumbruch. */
export function hasWhitespaceProblem(text: string): boolean {
  return text !== text.trim() || / {2,}|[\t\n\r]/.test(text);
}
