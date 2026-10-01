/**
 * Schrift-Teilmenge `latin-ext` von Rubik im Hintergrund laden, sobald eine Lobby offen ist. Vorgeladen wird nur
 * `latin` (app/fonts.ts: alle UI-Texte inkl. ä ö ü ß „“ –); `latin-ext` steht per `unicode-range` bereit und lädt
 * der Browser sonst erst, wenn ein Zeichen daraus erscheint – etwa ō, ł, ć, š in ≈ 0,7 % der Fragen oder in Namen.
 * In der Lobby nachgeladen, steht sie vor der ersten Frage bereit, ohne das LCP der Startseite zu belasten.
 */

/** Buchstaben aus `latin-ext` (U+0100–U+02BA) – trifft genau die Datei dieser Teilmenge. */
export const EXTENDED_GLYPH_SAMPLE = "ĀāĆćČčŁłŌōŚśŠšŽž";

/** CSS-Variable der Schrift (next/font, `variable` in app/fonts.ts) am `<html>`. */
const FONT_VARIABLE = "--font-rubik";

export interface ExtendedGlyphOptions {
  /** Standard `document.fonts` (CSS Font Loading API). */
  fonts?: Pick<FontFaceSet, "load"> | undefined;
  /** Familienliste; Standard: Wert von `--font-rubik` am `<html>` (`'Rubik', 'Rubik Fallback'`). */
  family?: string;
}

/**
 * Erste Familie einer CSS-Familienliste (Anführungszeichen beachtet). Nur sie wird geladen: Die Ersatzschrift von
 * next/font (`'Rubik Fallback'` = `local("Arial")`) fehlt etwa unter Android und Linux – mit ihr in der Liste schlüge
 * `load()` mit NetworkError fehl, obwohl Rubik selbst geladen wurde.
 */
function primaryFamily(list: string): string {
  const trimmed = list.trim();
  const quote = trimmed[0];
  if (quote === "'" || quote === '"') {
    const end = trimmed.indexOf(quote, 1);
    return end === -1 ? "" : trimmed.slice(0, end + 1);
  }
  return (trimmed.split(",")[0] ?? "").trim();
}

let requested = false;

export function preloadExtendedGlyphs(options: ExtendedGlyphOptions = {}): void {
  if (requested) return;
  const fonts = "fonts" in options ? options.fonts : typeof document === "undefined" ? undefined : document.fonts;
  if (fonts === undefined || typeof fonts.load !== "function") return;
  const family = primaryFamily(
    options.family ?? getComputedStyle(document.documentElement).getPropertyValue(FONT_VARIABLE),
  );
  if (family === "") return;
  requested = true;
  fonts.load(`1em ${family}`, EXTENDED_GLYPH_SAMPLE).catch((error: unknown) => {
    requested = false;
    console.warn("Schrift (latin-ext) nicht vorgeladen:", error instanceof Error ? error.name : "unbekannt");
  });
}

/** Nur für Tests: Merker zurücksetzen. */
export function resetFontPreloadForTests(): void {
  requested = false;
}
