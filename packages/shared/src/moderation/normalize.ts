/**
 * Normalisierung für die Namens-Moderation (docs/06 §Eingaben & Inhalte): NFKC, Kleinschreibung,
 * Umlaute (ä→ae bzw. ä→a), Diakritika, kyrillische/griechische Verwechsler, Leetspeak (0→o, 1→i/l, 3→e,
 * 4→a, 5→s, 7→t, @→a) und Trennzeichen. Wiederholungen („Fiiick“) behandelt der Matcher (terms.ts),
 * damit echte Doppelbuchstaben („Nutella“, „Minute“) keine Fehltreffer erzeugen.
 */
import { expandGermanUmlauts, splitCamelCase, stripDiacritics, wordTokens } from "../text.ts";

/** Häufige Verwechsler (nach Kleinschreibung) → lateinische Buchstaben. */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Kyrillisch
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  ь: "b",
  ѕ: "s",
  і: "i",
  ї: "i",
  ј: "j",
  ԁ: "d",
  һ: "h",
  ӏ: "l",
  // Griechisch
  α: "a",
  β: "b",
  γ: "y",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ω: "w",
  // Lateinische Sonderformen ohne Zerlegung
  ı: "i",
  ł: "l",
  ø: "o",
  đ: "d",
  ħ: "h",
  æ: "ae",
  œ: "oe",
};

/** Leetspeak ohne „1“ (die wird je Variante als „i“ oder „l“ gelesen). */
const LEET: Readonly<Record<string, string>> = {
  "0": "o",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "€": "e",
  "!": "i",
  "|": "l",
};

export type UmlautMode = "expand" | "strip";

/** Faltet Text auf die Vergleichsform (ohne Tokenisierung). */
export function foldForModeration(text: string, umlauts: UmlautMode, oneAs: "i" | "l" = "i"): string {
  let folded = text.normalize("NFKC").toLowerCase();
  folded = umlauts === "expand" ? expandGermanUmlauts(folded) : folded.replace(/ß/g, "ss");
  folded = stripDiacritics(folded);
  let out = "";
  for (const char of folded) {
    out += char === "1" ? oneAs : (CONFUSABLES[char] ?? LEET[char] ?? char);
  }
  return out;
}

/**
 * Trennt eine angehängte Initiale nach einem Wort mit mindestens 4 Buchstaben ab („ArthurE“ →
 * „Arthur E“, „JanaL“ → „Jana L“), damit sie mit dem Wortende keinen Begriff bildet. Kurze Formen
 * („HurE“) bleiben zusammen und werden weiter erkannt.
 */
export function detachGluedInitial(text: string): string {
  return text.replace(/(?<=\p{L}{3}\p{Ll})(?=\p{Lu}(?![\p{L}\p{N}]))/gu, " ");
}

/** Vergleichsformen eines Namens für eine Normalisierungs-Variante. */
export interface ModerationForm {
  /** Wörter des Namens (Trenner entfernt, gesperrt Geschriebenes zusammengezogen). */
  readonly tokens: readonly string[];
  /** Zusätzliche Wörter aus Binnenmajuskeln („DummeSau“ → „dumme“, „sau“). */
  readonly camelTokens: readonly string[];
  /** Alle Wörter ohne Trenner („H.u r-e“ → „hure“). */
  readonly compact: string;
}

/**
 * Alle Varianten, in denen ein Name geprüft wird: Umlaute ausgeschrieben und entfernt („Hürensohn“ →
 * „huerensohn“/„hurensohn“) × „1“ als „i“ oder „l“. Doppelte Varianten werden zusammengefasst.
 */
export function moderationForms(input: string): ModerationForm[] {
  const nfkc = detachGluedInitial(input.normalize("NFKC"));
  const camel = splitCamelCase(nfkc);
  const forms = new Map<string, ModerationForm>();
  for (const umlauts of ["expand", "strip"] as const) {
    for (const oneAs of ["i", "l"] as const) {
      const tokens = wordTokens(foldForModeration(nfkc, umlauts, oneAs));
      const camelTokens = wordTokens(foldForModeration(camel, umlauts, oneAs));
      const form: ModerationForm = { tokens, camelTokens, compact: tokens.join("") };
      forms.set(JSON.stringify(form), form);
    }
  }
  return [...forms.values()];
}

/**
 * Wörter mit erhaltenen Ziffern (ohne Leetspeak) – für Zahlencodes wie „88“ oder „1488“, die durch die
 * Leetspeak-Umwandlung sonst verloren gingen.
 */
export function digitPreservingTokens(input: string): string[] {
  return wordTokens(stripDiacritics(input.normalize("NFKC").toLowerCase()));
}
