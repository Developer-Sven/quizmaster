import type { CategoryVisual } from "../../../lib/ui/category";
import type { PlayerColor } from "../../../lib/ui/player";

/**
 * Beispieldaten nur für /dev/ui. Die Kategorien entsprechen der Tabelle in docs/09 §2 – im Produkt
 * kommen Name, Icon und Farbe immer aus den Daten (content/categories.json → DB → CategoryOption).
 */
export const SAMPLE_CATEGORIES: readonly CategoryVisual[] = [
  { name: "Bücher & Wörter", icon: "book-open", color: "#EBB447" },
  { name: "Comics", icon: "message-circle", color: "#F7DF45" },
  { name: "Computerspiele", icon: "gamepad-2", color: "#B2DF49" },
  { name: "Die 2000er", icon: "disc-3", color: "#BDC4D1" },
  { name: "Draußen im Grünen", icon: "leaf", color: "#47C252" },
  { name: "Essen & Trinken", icon: "utensils", color: "#F27C5F" },
  { name: "Glaube & Religion", icon: "scroll-text", color: "#ECDCAC" },
  { name: "Im Labor", icon: "flask-conical", color: "#26D9B5" },
  { name: "Kinofilme", icon: "clapperboard", color: "#EE5858" },
  { name: "Körper & Geist", icon: "brain", color: "#F994A2" },
  { name: "Kunst & Kultur", icon: "palette", color: "#EA537B" },
  { name: "Macht & Geld", icon: "landmark", color: "#33CC80" },
  { name: "Medien & Unterhaltung", icon: "star", color: "#F075B7" },
  { name: "Musik & Hits", icon: "music", color: "#5988F8" },
  { name: "Rund um die Welt", icon: "globe", color: "#3F9FF3" },
  { name: "Sport & Freizeit", icon: "trophy", color: "#7BCB4D" },
  { name: "TV-Serien", icon: "tv", color: "#35C8DE" },
  { name: "Wunder der Technik", icon: "cog", color: "#97B0C4" },
  { name: "Zeugen der Zeit", icon: "hourglass", color: "#BA9978" },
];

/** Unbekanntes Icon und ungültige Farbe: Anzeige ohne Icon und ohne Absturz. */
export const UNKNOWN_CATEGORY: CategoryVisual = { name: "Unbekanntes Icon", icon: "unbekannt", color: "rot" };

export function sampleCategory(index: number): CategoryVisual {
  const category = SAMPLE_CATEGORIES[index % SAMPLE_CATEGORIES.length];
  if (!category) throw new Error("Beispielkategorien fehlen");
  return category;
}

export interface SamplePlayer {
  id: string;
  name: string;
  color: PlayerColor;
}

export const SAMPLE_PLAYERS: readonly SamplePlayer[] = [
  { id: "p1", name: "Mia", color: "blue" },
  { id: "p2", name: "Ben", color: "sky" },
  { id: "p3", name: "Lea", color: "cyan" },
  { id: "p4", name: "Tom", color: "yellow" },
  { id: "p5", name: "Ida Sommer", color: "ochre" },
  { id: "p6", name: "Kai", color: "sand" },
  { id: "p7", name: "Zoe", color: "steel" },
  { id: "p8", name: "Max 2", color: "silver" },
];

export function samplePlayer(index: number): SamplePlayer {
  const player = SAMPLE_PLAYERS[index % SAMPLE_PLAYERS.length];
  if (!player) throw new Error("Beispielpersonen fehlen");
  return player;
}

/** Längste erlaubte Frage (140 Zeichen) und Antwort (40 Zeichen) für die Abnahme (docs/09 §13). */
export const LONGEST_QUESTION =
  "Welcher Fluss fließt auf seinem Weg zum Schwarzen Meer durch mehr Hauptstädte Europas als jeder andere, nämlich durch vier verschiedene davon?";
export const LONGEST_ANSWER = "Die Donau mit ihren vielen Nebenflüssen X";
export const SHORT_QUESTION = "Wie heißt die Hauptstadt von Australien?";

/** Wartungstext nahe der Grenze von `appConfig.maintenance.message` (200 Zeichen) – bricht im Banner um. */
export const LONG_MAINTENANCE_MESSAGE =
  "Heute Abend spielen wir ein größeres Update ein. Zwischen 22 und 23 Uhr kann es kurze Unterbrechungen geben, laufende Spiele enden vorher sauber. Danke für deine Geduld, bis gleich wieder am Tisch.";
