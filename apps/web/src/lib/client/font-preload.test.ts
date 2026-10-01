/**
 * Schrift-Teilmenge `latin-ext` im Hintergrund (lib/client/font-preload.ts): Vorgeladen wird nur `latin`
 * (app/fonts.ts); `latin-ext` lädt die Lobby-Seite einmal nach, damit Fragen und Namen mit ō, ł, ć, š … im Spiel
 * nicht erst beim Erscheinen auf die Schrift warten.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTENDED_GLYPH_SAMPLE, preloadExtendedGlyphs, resetFontPreloadForTests } from "./font-preload";

/** Google-Fonts-Bereich `latin-ext` (Rubik) – Ausschnitt mit den Buchstaben. */
const inLatinExt = (char: string) => {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x0100 && code <= 0x02ba) || (code >= 0x1e00 && code <= 0x1e9f);
};

afterEach(() => {
  resetFontPreloadForTests();
  vi.restoreAllMocks();
});

describe("preloadExtendedGlyphs", () => {
  it("lädt latin-ext von Rubik genau einmal – nur die erste Familie aus --font-rubik", async () => {
    const load = vi.fn(async () => []);
    // Die Ersatzschrift ('Rubik Fallback' = local("Arial")) fehlt z. B. unter Android und Linux: Mit ihr in der Liste
    // schlüge load() mit NetworkError fehl, obwohl Rubik selbst geladen wurde.
    preloadExtendedGlyphs({ fonts: { load }, family: "'Rubik', 'Rubik Fallback'" });
    preloadExtendedGlyphs({ fonts: { load }, family: "'Rubik', 'Rubik Fallback'" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("1em 'Rubik'", EXTENDED_GLYPH_SAMPLE);
    expect([...EXTENDED_GLYPH_SAMPLE].every(inLatinExt)).toBe(true);
  });

  it("nimmt die erste Familie auch ohne Anführungszeichen oder mit Komma im Namen", () => {
    const load = vi.fn(async () => []);
    preloadExtendedGlyphs({ fonts: { load }, family: ' "Rubik, Display" , serif' });
    expect(load).toHaveBeenLastCalledWith('1em "Rubik, Display"', EXTENDED_GLYPH_SAMPLE);
    resetFontPreloadForTests();
    preloadExtendedGlyphs({ fonts: { load }, family: "__Rubik_5a1b, __Rubik_Fallback_5a1b" });
    expect(load).toHaveBeenLastCalledWith("1em __Rubik_5a1b", EXTENDED_GLYPH_SAMPLE);
  });

  it("ohne Font-Loading-API oder ohne Schriftvariable: nichts tun, später erneut möglich", () => {
    const load = vi.fn(async () => []);
    preloadExtendedGlyphs({ fonts: undefined, family: "'Rubik'" });
    preloadExtendedGlyphs({ fonts: { load }, family: "  " });
    expect(load).not.toHaveBeenCalled();
    preloadExtendedGlyphs({ fonts: { load }, family: "'Rubik'" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("Fehlschlag wird gemeldet (ohne Ausnahme) und gibt einen neuen Versuch frei", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const load = vi.fn(async (): Promise<FontFace[]> => {
      throw new DOMException("Netz weg", "NetworkError");
    });
    preloadExtendedGlyphs({ fonts: { load }, family: "'Rubik'" });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    preloadExtendedGlyphs({ fonts: { load }, family: "'Rubik'" });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
