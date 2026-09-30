/**
 * Lobby-Codes (docs/05 §Lobby-Codes): 6 Zeichen aus einem Alphabet ohne verwechselbare Zeichen
 * (kein I, L, O, 0, 1) → 31^6 ≈ 887 Mio. Kombinationen. Clientfähig; der Zufall wird injiziert
 * (Server: `crypto.randomInt`), damit das Modul ohne `node:`-Importe auskommt und testbar bleibt.
 */

export const LOBBY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LOBBY_CODE_LENGTH = 6;
export const LOBBY_CODE_REGEX = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
/** Obergrenze für rohe Eingaben (mit Leerzeichen/Bindestrichen), bevor normalisiert wird. */
export const LOBBY_CODE_INPUT_MAX_LENGTH = 32;
/** Maximale Versuche beim Erzeugen (docs/05: Kollision → neu, max. 5 Versuche). */
export const LOBBY_CODE_MAX_ATTEMPTS = 5;

/** Zufallsquelle: ganze Zahl in [0, maxExclusive) – z. B. `randomInt` aus `node:crypto`. */
export type RandomInt = (maxExclusive: number) => number;

/**
 * Normalisiert eine Code-Eingabe: NFKC (Vollbreiten-Zeichen), Großbuchstaben, Leerzeichen und
 * Bindestriche/Striche entfernt („abc-234“, „ABC 234“ → „ABC234“). Prüft nicht auf Gültigkeit.
 */
export function normalizeLobbyCode(input: string): string {
  return input
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s\p{Pd}]+/gu, "");
}

/** true für einen normalisierten, gültigen Code (genau 6 Zeichen aus dem Alphabet). */
export function isValidLobbyCode(code: string): boolean {
  return LOBBY_CODE_REGEX.test(code);
}

/** Anzeigeform mit Lücke: „ABC234“ → „ABC 234“. Ungültige Eingaben kommen normalisiert zurück. */
export function formatLobbyCode(code: string): string {
  const normalized = normalizeLobbyCode(code);
  if (!isValidLobbyCode(normalized)) return normalized;
  return `${normalized.slice(0, 3)} ${normalized.slice(3)}`;
}

/**
 * Zeichenfolgen, die in keinem Code vorkommen dürfen (Schimpfwörter, sexuelle, rassistische und
 * NS-Bezüge), nur aus Zeichen des Code-Alphabets. Geprüft wird der Code selbst und seine
 * „Leetspeak“-Lesart (Ziffern → ähnliche Buchstaben, siehe `CODE_DIGIT_AS_LETTER`).
 */
export const LOBBY_CODE_BLOCKLIST: readonly string[] = [
  "FUCK",
  "FUK",
  "FCK",
  "FVCK",
  "CUNT",
  "KUNT",
  "SEX",
  "PUSSY",
  "PUSY",
  "CUM",
  "WANK",
  "TWAT",
  "DYKE",
  "FAG",
  "GAY",
  "RAPE",
  "NGGR",
  "NGGA",
  "NEGER",
  "NEGR",
  "ARSCH",
  "HURE",
  "NUTTE",
  "KACK",
  "SPERMA",
  "BUMS",
  "SPAST",
  "KANAK",
  "PENNER",
  "SAU",
  "JUDE",
  "NAZ",
  "NSDAP",
  "NSU",
  "SS",
  "KZ",
  "KKK",
  "HH",
  "88",
  "ACAB",
  "WTF",
  "STFU",
];

/** Ziffern, die als Buchstaben gelesen werden können (2→Z, 3→E, 4→A, 5→S, 6→G, 7→T, 8→B, 9→G). */
export const CODE_DIGIT_AS_LETTER: Readonly<Record<string, string>> = {
  "2": "Z",
  "3": "E",
  "4": "A",
  "5": "S",
  "6": "G",
  "7": "T",
  "8": "B",
  "9": "G",
};

/** Liest Ziffern eines Codes als Buchstaben („5EX“ → „SEX“). */
export function codeAsLetters(code: string): string {
  return code.replace(/[2-9]/g, (digit) => CODE_DIGIT_AS_LETTER[digit] ?? digit);
}

/** true, wenn der (normalisierte) Code keine gesperrte Zeichenfolge enthält – auch nicht in Leetspeak. */
export function isLobbyCodeClean(code: string): boolean {
  const normalized = normalizeLobbyCode(code);
  const lettered = codeAsLetters(normalized);
  return !LOBBY_CODE_BLOCKLIST.some((blocked) => normalized.includes(blocked) || lettered.includes(blocked));
}

/** Zieht einen zufälligen Code (ohne Blocklisten- oder Kollisionsprüfung). */
export function drawLobbyCode(randomInt: RandomInt): string {
  let code = "";
  for (let i = 0; i < LOBBY_CODE_LENGTH; i++) {
    const index = randomInt(LOBBY_CODE_ALPHABET.length);
    const char = Number.isInteger(index) ? LOBBY_CODE_ALPHABET[index] : undefined;
    if (char === undefined) {
      throw new RangeError(`randomInt lieferte ${index}, erwartet 0…${LOBBY_CODE_ALPHABET.length - 1}`);
    }
    code += char;
  }
  return code;
}

export interface GenerateLobbyCodeOptions {
  /**
   * Inhaltliche Prüfung eines gezogenen Codes. Standard: `isLobbyCodeClean`; der Realtime-Server
   * übergibt `isCodeAcceptable` aus `@quizmaster/shared/moderation` (zusätzlich Namens-Blocklisten).
   */
  isAcceptable?: (code: string) => boolean;
  /** Maximale Anzahl Ziehungen (Standard `LOBBY_CODE_MAX_ATTEMPTS` = 5). */
  maxAttempts?: number;
}

/**
 * Erzeugt einen freien, unbedenklichen Lobby-Code. Jede Ziehung ist ein Versuch: Codes mit
 * Blocklisten-Treffer werden verworfen (ohne `isTaken` zu fragen), belegte Codes ebenfalls; nach
 * `maxAttempts` (5) Versuchen ohne Erfolg kommt `null` zurück (Aufrufer antwortet z. B. `SERVER_BUSY`).
 * Die endgültige Eindeutigkeit sichert zusätzlich der Unique-Index auf aktiven Lobbys (docs/04).
 */
export async function generateLobbyCode(
  randomInt: RandomInt,
  isTaken: (code: string) => boolean | Promise<boolean>,
  options: GenerateLobbyCodeOptions = {},
): Promise<string | null> {
  const isAcceptable = options.isAcceptable ?? isLobbyCodeClean;
  const maxAttempts = options.maxAttempts ?? LOBBY_CODE_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = drawLobbyCode(randomInt);
    if (!isAcceptable(code)) continue;
    if (!(await isTaken(code))) return code;
  }
  return null;
}
