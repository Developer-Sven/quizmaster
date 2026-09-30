/**
 * Eingabelogik des CodeInput. Gültigkeit und Anzeige („ABC 234“) liefert @quizmaster/shared
 * (`isValidLobbyCode`, `formatLobbyCode`); hier nur das, was beim Tippen und Einfügen passiert.
 * Bewusst ohne Laufzeit-Import aus dem Paket, damit die Startseite schlank bleibt – lobby-code.test.ts
 * prüft die Übereinstimmung mit `normalizeLobbyCode` aus @quizmaster/shared.
 */

/** Länge eines Lobby-Codes (docs/05 „Lobby-Codes“). */
export const LOBBY_CODE_LENGTH = 6;

const INVITE_LINK = /\/j\/([^/?#\s]+)/i;
const SEPARATORS = /[\s\p{Pd}]+/gu;
const NOT_ALPHANUMERIC = /[^A-Z0-9]/g;

/**
 * Normalisiert eine Code-Eingabe (docs/01, docs/05): NFKC, Großbuchstaben, ohne Leerzeichen und
 * Bindestriche, höchstens 6 Zeichen. Eingefügte Einladungslinks (`…/j/ABC234`) liefern ihren Code;
 * übrige Satzzeichen fallen weg. Ob der Code gültig ist, entscheidet der Server.
 */
export function normalizeCodeInput(raw: string): string {
  return normalizeUnlimited(raw).slice(0, LOBBY_CODE_LENGTH);
}

function normalizeUnlimited(raw: string): string {
  const fromLink = INVITE_LINK.exec(raw)?.[1];
  return (fromLink ?? raw).normalize("NFKC").toUpperCase().replace(SEPARATORS, "").replace(NOT_ALPHANUMERIC, "");
}

/** Ergebnis einer Eingabe im CodeInput. */
export interface CodeInputChange {
  value: string;
  /** true genau dann, wenn diese Eingabe den Code auf 6 Zeichen vervollständigt hat */
  completed: boolean;
}

/**
 * Berechnet den neuen Wert einer Code-Eingabe und ob sie gerade vollständig geworden ist.
 * Einfügungen in einen vollen Code werden verworfen (wie `maxLength`): Mit der Marke in der Mitte fiele
 * sonst das letzte Zeichen weg und der verschobene Code löste den Auto-Beitritt aus. Ersetzen per
 * Markierung, Löschen und hineingezogene Einladungslinks bleiben möglich. Kein `maxLength` am Feld,
 * weil es Links und diktierte Codes („ABC 234“) vor der Normalisierung abschneiden würde.
 */
export function applyCodeInput(previous: string, raw: string): CodeInputChange {
  const full = previous.length === LOBBY_CODE_LENGTH;
  if (full && !INVITE_LINK.test(raw) && normalizeUnlimited(raw).length > LOBBY_CODE_LENGTH) {
    return { value: previous, completed: false };
  }
  const value = normalizeCodeInput(raw);
  return { value, completed: value.length === LOBBY_CODE_LENGTH && value !== previous };
}

/** Woher eine Auswahländerung im CodeInput kam. */
export type CaretSource = "pointer" | "keyboard";

/**
 * Einfügemarke nach einer Auswahländerung: zu setzende Position oder `null` (nichts ändern).
 * Per Tastatur bleibt sie frei – Pfeile, Pos1/Ende und Umschalt+Pfeil wirken wie in jedem Textfeld
 * (WCAG 2.1.1, Screenreader lesen zeichenweise). Nach Tippen/Klicken springt sie ans Ende: Das
 * unsichtbare Feld liegt über den Zellen, die Klickposition entspricht keiner Zelle. Alles-Markieren
 * bleibt in beiden Fällen erhalten.
 */
export function caretAfterSelect(source: CaretSource, start: number, end: number, length: number): number | null {
  if (source === "keyboard") return null;
  const all = start === 0 && end === length;
  const atEnd = start === length && end === length;
  return all || atEnd ? null : length;
}

/** Aktive Zelle: dort landet das nächste Zeichen (an der Einfügemarke), höchstens die letzte Zelle. */
export function activeCodeCell(length: number, caret: number | null): number {
  const position = caret === null ? length : Math.min(caret, length);
  return Math.min(Math.max(0, position), LOBBY_CODE_LENGTH - 1);
}

/**
 * Einfügen: Ein vollständiger Code (oder Einladungslink) ersetzt die bisherige Eingabe,
 * ein Teilstück wird angehängt.
 */
export function applyCodePaste(previous: string, pasted: string): CodeInputChange {
  const pastedCode = normalizeCodeInput(pasted);
  const raw = pastedCode.length === LOBBY_CODE_LENGTH ? pastedCode : previous + pastedCode;
  return applyCodeInput(previous, raw);
}
