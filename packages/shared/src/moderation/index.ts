/**
 * Subpath "@quizmaster/shared/moderation" – SERVER-ONLY (ADR-021): Schimpfwortfilter für Spielernamen
 * und Lobby-Codes (docs/06 §Eingaben & Inhalte). Kombiniert `obscenity` (englisches Dataset) mit der
 * eigenen deutschen Blockliste, NS-Zahlencodes und Live-Ergänzungen aus `appConfig.blockedTerms`.
 */
import { codeAsLetters, isLobbyCodeClean, normalizeLobbyCode } from "../lobby-code.ts";
import { isReservedName, type NameFormatError, validateNameFormat } from "../names.ts";
import { splitCamelCase, stripDiacritics, wordTokens } from "../text.ts";
import { GERMAN_BLOCKLIST, GERMAN_WHITELIST, NS_NUMBER_CODES } from "./blocklist-de.ts";
import { matchesEnglish } from "./english.ts";
import { digitPreservingTokens, foldForModeration, moderationForms } from "./normalize.ts";
import { TermMatcher } from "./terms.ts";

export {
  ENGLISH_DATASET_WHITELIST_DE,
  GERMAN_BLOCKLIST,
  GERMAN_WHITELIST,
  NS_NUMBER_CODES,
} from "./blocklist-de.ts";
export { foldForModeration, type ModerationForm, moderationForms } from "./normalize.ts";
export { type CompiledTerm, compileTerm, type TermKind, TermMatcher } from "./terms.ts";

/** Welche Liste einen Namen gesperrt hat (für Logs/Metriken – nie an Clients). */
export type ModerationSource = "english" | "german" | "extra" | "number_code";

/** Live-Ergänzungen mit weniger Zeichen gelten automatisch als ganzes Wort (Schutz vor Massensperren). */
export const EXTRA_TERM_WHOLE_WORD_BELOW = 4;

let germanMatcher: TermMatcher | undefined;

function german(): TermMatcher {
  germanMatcher ??= new TermMatcher(GERMAN_BLOCKLIST, GERMAN_WHITELIST);
  return germanMatcher;
}

let extraCache: { key: string; matcher: TermMatcher } | undefined;

/** Matcher für `appConfig.blockedTerms`; gecacht, solange sich die Liste nicht ändert. */
function extraMatcher(extraTerms: readonly string[]): TermMatcher | undefined {
  if (extraTerms.length === 0) return undefined;
  const key = extraTerms.join("\u0000");
  if (extraCache?.key !== key) {
    extraCache = { key, matcher: new TermMatcher(extraTerms, GERMAN_WHITELIST, EXTRA_TERM_WHOLE_WORD_BELOW) };
  }
  return extraCache.matcher;
}

const STANDALONE_NUMBER_PATTERNS = NS_NUMBER_CODES.standalone.map(
  (code) => new RegExp(`(?:^|\\D)${code}(?:\\D|$)`, "u"),
);

/** NS-Zahlencodes (ohne Leetspeak, damit die Ziffern erhalten bleiben). */
function hasNsNumberCode(name: string): boolean {
  const compact = stripDiacritics(name.normalize("NFKC").toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, "");
  if (STANDALONE_NUMBER_PATTERNS.some((regex) => regex.test(compact))) return true;
  if (NS_NUMBER_CODES.contains.some((code) => compact.includes(code))) return true;
  return digitPreservingTokens(name).some((token) => NS_NUMBER_CODES.wholeWords.includes(token));
}

/**
 * Eingaben für den englischen Matcher: Binnenmajuskeln getrennt („AnnaL“ → „Anna L“, damit angehängte
 * Initialen keine Treffer bilden), mit/ohne Diakritika, plus Wörter ohne Trennzeichen („f.u.c.k“, „fUcK“).
 */
function englishInputs(name: string): Set<string> {
  const spaced = splitCamelCase(name.normalize("NFKC"));
  const words = wordTokens(foldForModeration(spaced, "strip")).join(" ");
  return new Set([spaced, stripDiacritics(spaced), words]);
}

/**
 * Prüft einen Namen gegen alle Listen und liefert die Quelle des ersten Treffers, sonst `null`.
 * `extraTerms` = `appConfig.blockedTerms` (Syntax wie die Blockliste: `|wort|`, `|wort`, `wort|`, `wort`;
 * Begriffe unter 4 Zeichen gelten als ganzes Wort).
 */
export function findNameViolation(name: string, extraTerms: readonly string[] = []): ModerationSource | null {
  if (hasNsNumberCode(name)) return "number_code";
  const forms = moderationForms(name);
  if (german().findIn(forms)) return "german";
  if (extraMatcher(extraTerms)?.findIn(forms)) return "extra";
  if (matchesEnglish(englishInputs(name))) return "english";
  return null;
}

/** true, wenn der Name keine gesperrten Begriffe enthält (Format/Reserviert prüft `checkName`). */
export function isNameAcceptable(name: string, extraTerms: readonly string[] = []): boolean {
  return findNameViolation(name, extraTerms) === null;
}

export type NameCheckResult =
  | { ok: true; name: string }
  | { ok: false; reason: "format"; detail: NameFormatError }
  | { ok: false; reason: "reserved" }
  | { ok: false; reason: "blocked"; source: ModerationSource };

/**
 * Vollständige Namensprüfung für `lobby:create`/`lobby:join`: normalisieren → Format → reserviert →
 * Blocklisten. Jeder Fehler wird dem Client als `NAME_REJECTED` gemeldet; bei Erfolg kommt der
 * normalisierte Name zurück (danach `makeUniqueName` für die Lobby).
 */
export function checkName(raw: string, extraTerms: readonly string[] = []): NameCheckResult {
  const format = validateNameFormat(raw);
  if (!format.ok) return { ok: false, reason: "format", detail: format.reason };
  if (isReservedName(format.name)) return { ok: false, reason: "reserved" };
  const source = findNameViolation(format.name, extraTerms);
  if (source !== null) return { ok: false, reason: "blocked", source };
  return { ok: true, name: format.name };
}

/**
 * Prüft einen Lobby-Code: Code-Blockliste (auch in Leetspeak-Lesart) plus die Namens-Blocklisten auf
 * der Buchstabenfolge. Für `generateLobbyCode(randomInt, isTaken, { isAcceptable: isCodeAcceptable })`.
 */
export function isCodeAcceptable(code: string): boolean {
  const normalized = normalizeLobbyCode(code);
  if (!isLobbyCodeClean(normalized)) return false;
  const lettered = codeAsLetters(normalized);
  const forms = [...moderationForms(normalized), ...moderationForms(lettered)];
  if (german().findIn(forms)) return false;
  return !matchesEnglish([normalized.toLowerCase(), lettered.toLowerCase()]);
}
