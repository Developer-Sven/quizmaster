/**
 * Kleine, clientfähige Text-Helfer (Grapheme, Diakritika, Tokens). Werden von Namen, Lobby-Codes und
 * der serverseitigen Moderation gemeinsam genutzt, damit alle Seiten gleich normalisieren.
 */

let graphemeSegmenter: Intl.Segmenter | undefined;

function segmenter(): Intl.Segmenter {
  graphemeSegmenter ??= new Intl.Segmenter("de", { granularity: "grapheme" });
  return graphemeSegmenter;
}

/** Zerlegt Text in Grapheme (vom Menschen wahrgenommene Zeichen, z. B. „é“ oder „👍🏽“ = 1). */
export function graphemes(text: string): string[] {
  return Array.from(segmenter().segment(text), (part) => part.segment);
}

export function countGraphemes(text: string): number {
  let count = 0;
  for (const _ of segmenter().segment(text)) count++;
  return count;
}

/** Kürzt auf höchstens `max` Grapheme, ohne ein Graphem zu zerschneiden. */
export function truncateGraphemes(text: string, max: number): string {
  if (max <= 0) return "";
  const parts = graphemes(text);
  return parts.length <= max ? text : parts.slice(0, max).join("");
}

/** Entfernt Diakritika („é“ → „e“, „ü“ → „u“) – NFD, Kombinationszeichen weg, zurück nach NFC. */
export function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}

/** Deutsche Umschrift in Kleinbuchstaben-Text: ä→ae, ö→oe, ü→ue, ß→ss. */
export function expandGermanUmlauts(text: string): string {
  return text.replace(/[äöüß]/g, (char) => UMLAUT_EXPANSION[char] ?? char);
}

const UMLAUT_EXPANSION: Readonly<Record<string, string>> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };

/** Fügt an Binnenmajuskeln ein Leerzeichen ein („DummeSau“ → „Dumme Sau“, „McFly“ → „Mc Fly“). */
export function splitCamelCase(text: string): string {
  return text.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2");
}

/** Tokens bis zu dieser Länge gelten als Bruchstück und werden mit Nachbar-Bruchstücken verbunden. */
export const FRAGMENT_MAX_LENGTH = 2;

/**
 * Zerlegt Text in Wörter: getrennt an allem außer Buchstaben/Ziffern und an Buchstabe↔Ziffer-Grenzen.
 * Aufeinanderfolgende Bruchstücke (≤ 2 Zeichen) werden verbunden („F i c k“, „Hu-Re“ → ein Wort), damit
 * gesperrt oder zerstückelt geschriebene Wörter als Wort erkannt werden; einzelne Initialen bleiben
 * eigene Wörter („Anna L“ → „anna“, „l“).
 */
export function wordTokens(text: string): string[] {
  const raw = text
    .split(/[^\p{L}\p{N}]+/u)
    .flatMap((part) => part.split(/(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u))
    .filter((part) => part.length > 0);
  return mergeFragmentRuns(raw);
}

function mergeFragmentRuns(tokens: readonly string[]): string[] {
  const merged: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) merged.push(run.join(""));
    run = [];
  };
  for (const token of tokens) {
    if (Array.from(token).length <= FRAGMENT_MAX_LENGTH) {
      run.push(token);
      continue;
    }
    flush();
    merged.push(token);
  }
  flush();
  return merged;
}
