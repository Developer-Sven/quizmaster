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
  const fromLink = INVITE_LINK.exec(raw)?.[1];
  return (fromLink ?? raw)
    .normalize("NFKC")
    .toUpperCase()
    .replace(SEPARATORS, "")
    .replace(NOT_ALPHANUMERIC, "")
    .slice(0, LOBBY_CODE_LENGTH);
}

/** Ergebnis einer Eingabe im CodeInput. */
export interface CodeInputChange {
  value: string;
  /** true genau dann, wenn diese Eingabe den Code auf 6 Zeichen vervollständigt hat */
  completed: boolean;
}

/** Berechnet den neuen Wert einer Code-Eingabe und ob sie gerade vollständig geworden ist. */
export function applyCodeInput(previous: string, raw: string): CodeInputChange {
  const value = normalizeCodeInput(raw);
  return { value, completed: value.length === LOBBY_CODE_LENGTH && value !== previous };
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
