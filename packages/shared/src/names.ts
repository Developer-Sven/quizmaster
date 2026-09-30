/**
 * Spielernamen (docs/01 §Lobby, docs/06 §Eingaben & Inhalte) – clientfähig. Die Schimpfwort-Prüfung
 * ist serverseitig (`@quizmaster/shared/moderation`); hier liegen Normalisierung, Format- und
 * Reserviert-Prüfung sowie die Eindeutigkeit in der Lobby.
 */
import { countGraphemes, graphemes, splitCamelCase, stripDiacritics, truncateGraphemes, wordTokens } from "./text.ts";

export const NAME_MIN_GRAPHEMES = 2;
export const NAME_MAX_GRAPHEMES = 16;
/** Obergrenze der rohen Eingabe (UTF-16-Einheiten) im Socket-Payload – vor der Normalisierung. */
export const NAME_INPUT_MAX_LENGTH = 64;
/** Kombinationszeichen je Graphem (Akzente, indische Vokalzeichen …); mehr = „Zalgo“-Text. */
export const NAME_MAX_MARKS_PER_GRAPHEME = 3;

/** Reservierte Namen (docs/06) – auch als Wort im Namen, in Leetspeak oder mit Ziffern-Anhang. */
export const RESERVED_NAMES = ["admin", "host", "system", "moderator", "quizmaster", "server"] as const;

export const NAME_FORMAT_ERRORS = ["too_short", "too_long", "invalid_characters", "needs_letter_or_digit"] as const;
export type NameFormatError = (typeof NAME_FORMAT_ERRORS)[number];

export type NameFormatResult = { ok: true; name: string } | { ok: false; reason: NameFormatError };

/** NFKC, Leerzeichen am Rand entfernen, mehrere Leerzeichen zu einem zusammenfassen. */
export function normalizeName(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/ {2,}/g, " ");
}

/** Erlaubt: Buchstaben (inkl. Kombinationszeichen), Ziffern, Leerzeichen, `_`, `-`, `.`. */
const ALLOWED_CHAR = /^[\p{L}\p{Mn}\p{Mc}\p{Nd} ._-]$/u;
/** Verboten, auch wenn als Buchstabe/Zeichen klassifiziert: unsichtbare Zeichen, Bidi, Emojis. */
const FORBIDDEN_CHAR = /[\p{Default_Ignorable_Code_Point}\p{Extended_Pictographic}\p{Emoji_Presentation}\p{RI}]/u;
const MARK = /^\p{M}$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;

/**
 * Prüft das Namensformat (normalisiert vorher selbst): 2–16 Grapheme (`Intl.Segmenter`), nur erlaubte
 * Zeichen, keine Steuer-, Zero-Width-, Bidi-Zeichen oder Emojis, höchstens 3 Kombinationszeichen je
 * Graphem und mindestens ein Buchstabe oder eine Ziffer. Liefert bei Erfolg den normalisierten Namen.
 */
export function validateNameFormat(raw: string): NameFormatResult {
  const name = normalizeName(raw);
  // Auch normalisiert höchstens 64 UTF-16-Einheiten (NFKC kann Zeichen erweitern, z. B. „ﷺ“).
  if (name.length > NAME_INPUT_MAX_LENGTH) return { ok: false, reason: "too_long" };
  const parts = graphemes(name);
  if (parts.length < NAME_MIN_GRAPHEMES) return { ok: false, reason: "too_short" };
  if (parts.length > NAME_MAX_GRAPHEMES) return { ok: false, reason: "too_long" };
  if (!parts.every(isAllowedGrapheme)) return { ok: false, reason: "invalid_characters" };
  if (!LETTER_OR_DIGIT.test(name)) return { ok: false, reason: "needs_letter_or_digit" };
  return { ok: true, name };
}

function isAllowedGrapheme(grapheme: string): boolean {
  const chars = Array.from(grapheme);
  const base = chars[0];
  if (base === undefined || MARK.test(base)) return false;
  let marks = 0;
  for (const char of chars) {
    if (!ALLOWED_CHAR.test(char) || FORBIDDEN_CHAR.test(char)) return false;
    if (MARK.test(char)) marks++;
  }
  // Kombinationszeichen nur an Buchstaben/Ziffern, nicht an Leerzeichen oder Satzzeichen.
  return marks === 0 || (marks <= NAME_MAX_MARKS_PER_GRAPHEME && LETTER_OR_DIGIT.test(base));
}

const RESERVED: ReadonlySet<string> = new Set(RESERVED_NAMES);

/** Leetspeak-Ziffern → Buchstaben (docs/06: 0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a). */
const LEET: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a" };

function deLeet(text: string): string {
  return text.replace(/[013457@]/g, (char) => LEET[char] ?? char);
}

/**
 * true, wenn der Name einen reservierten Namen darstellt – als ganzer Name, als Wort im Namen
 * („Mia Host“), in Leetspeak („4dm1n“), gesperrt geschrieben („A d m i n“) oder mit Ziffern („Admin2“).
 * „Ghost“ oder „Hostel“ sind erlaubt (nur ganze Wörter zählen).
 */
export function isReservedName(name: string): boolean {
  const base = splitCamelCase(stripDiacritics(normalizeName(name)));
  const plain = base.toLowerCase();
  const tokenSets = [wordTokens(plain), wordTokens(deLeet(plain))];
  for (const tokens of tokenSets) {
    const compact = tokens.join("");
    const candidates = [...tokens, compact, compact.replace(/\d+$/, "")];
    if (candidates.some((candidate) => RESERVED.has(deLeet(candidate)))) return true;
  }
  return false;
}

/** Vergleichsschlüssel für die Eindeutigkeit in der Lobby (Groß-/Kleinschreibung egal). */
export function nameKey(name: string): string {
  return normalizeName(name).toLowerCase();
}

/**
 * Macht einen Namen in der Lobby eindeutig: bei Kollision „Mia 2“, „Mia 3“ … (docs/01). Der Anhang
 * passt immer in 16 Grapheme – der Name wird dafür notfalls gekürzt.
 */
export function makeUniqueName(name: string, taken: Iterable<string>): string {
  const normalized = normalizeName(name);
  const takenKeys = new Set(Array.from(taken, nameKey));
  if (!takenKeys.has(nameKey(normalized))) return normalized;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const base = truncateGraphemes(normalized, NAME_MAX_GRAPHEMES - countGraphemes(suffix)).trimEnd();
    const candidate = `${base}${suffix}`;
    if (!takenKeys.has(nameKey(candidate))) return candidate;
  }
}
