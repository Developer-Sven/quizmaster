import type { PlayerColor } from "@quizmaster/shared";

export type { PlayerColor };

/**
 * Avatar-Fläche je Spielerfarbe als Token-Klasse (docs/09 §2), in Vergabe-Reihenfolge (docs/05).
 * Vollständige Klassennamen, damit Tailwind sie findet; der Typ erzwingt jede Farbe aus
 * `@quizmaster/shared` (bewusst ohne Grün, Rot, Pink und Lila).
 */
export const PLAYER_COLOR_BG: Readonly<Record<PlayerColor, string>> = {
  blue: "bg-player-blue",
  sky: "bg-player-sky",
  cyan: "bg-player-cyan",
  yellow: "bg-player-yellow",
  ochre: "bg-player-ochre",
  sand: "bg-player-sand",
  steel: "bg-player-steel",
  silver: "bg-player-silver",
};

/** Spielerfarben in Vergabe-Reihenfolge (für Listen, z. B. /dev/ui). */
export const PLAYER_COLOR_ORDER = Object.keys(PLAYER_COLOR_BG) as PlayerColor[];

/** Typwächter für Farben aus Daten (unbekannte Werte fallen auf `blue` zurück, siehe {@link playerColorBg}). */
export function isPlayerColor(value: string): value is PlayerColor {
  return Object.hasOwn(PLAYER_COLOR_BG, value);
}

/** Token-Klasse für eine Spielerfarbe; unbekannte Werte ergeben die erste Farbe statt eines Absturzes. */
export function playerColorBg(color: string): string {
  return isPlayerColor(color) ? PLAYER_COLOR_BG[color] : PLAYER_COLOR_BG.blue;
}

const graphemes = new Intl.Segmenter("de", { granularity: "grapheme" });

function firstGraphemes(text: string, count: number): string {
  let result = "";
  let taken = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (taken === count) break;
    result += segment;
    taken += 1;
  }
  return result;
}

/**
 * Initialen für Avatare (1–2 Buchstaben, docs/09 §5): bei mehreren Wörtern Anfang des ersten und
 * letzten Wortes („Mia 2“ → „M2“), sonst die ersten zwei Zeichen („Lea“ → „LE“). Graphem-sicher.
 */
export function initialsOf(name: string): string {
  const words = name
    .normalize("NFKC")
    .trim()
    .split(/[\s._-]+/u)
    .filter(Boolean);
  const first = words[0];
  if (first === undefined) return "";
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const raw = last === undefined ? firstGraphemes(first, 2) : firstGraphemes(first, 1) + firstGraphemes(last, 1);
  return firstGraphemes(raw.toLocaleUpperCase("de-DE"), 2);
}
