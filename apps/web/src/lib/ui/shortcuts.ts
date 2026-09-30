/**
 * Tastenkürzel (docs/09 §12): Antworten mit `1`–`4` bzw. `A`–`D`, Kategorien mit `1`–`3`.
 * Die Overlays hängen einen `keydown`-Listener an und übersetzen die Taste hiermit; Eingaben in
 * Textfeldern und Tasten mit Modifikatoren werden ignoriert.
 */
export type AnswerIndex = 0 | 1 | 2 | 3;

const ANSWER_KEYS: Readonly<Record<string, AnswerIndex>> = {
  "1": 0,
  "2": 1,
  "3": 2,
  "4": 3,
  a: 0,
  b: 1,
  c: 2,
  d: 3,
};

const CATEGORY_KEYS: Readonly<Record<string, 0 | 1 | 2>> = { "1": 0, "2": 1, "3": 2 };

interface KeyLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  target?: EventTarget | null;
}

function isTyping(target: EventTarget | null | undefined): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function lookup<T>(table: Readonly<Record<string, T>>, event: KeyLike): T | null {
  if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return null;
  const key = event.key.toLowerCase();
  return Object.hasOwn(table, key) ? (table[key] ?? null) : null;
}

/** Antwort-Index zur Taste oder `null`. */
export function answerIndexForKey(event: KeyLike): AnswerIndex | null {
  return lookup(ANSWER_KEYS, event);
}

/** Kategorie-Index (0–2) zur Taste oder `null`. */
export function categoryIndexForKey(event: KeyLike): 0 | 1 | 2 | null {
  return lookup(CATEGORY_KEYS, event);
}
