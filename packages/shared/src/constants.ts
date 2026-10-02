/**
 * Feste Wertelisten des Spiels (docs/01, docs/05, docs/09). Alles als `as const`-Tupel + Union-Typ
 * (keine enums, ADR-014); zod-Schemas bauen mit `z.enum(...)`/`z.literal(...)` darauf auf.
 */

/** Arbeitstitel der App (ADR-030: finaler Name folgt beim Umzug auf eine eigene Domain). */
export const APP_NAME = "quizmaster";

/** Spielphasen in Ablaufreihenfolge (docs/05 §Phasen, docs/02 §Zustandsautomat). */
export const PHASES = [
  "lobby",
  "intro",
  "category_pick",
  "question",
  "reveal",
  "turn_summary",
  "round_board",
  "game_over",
] as const;
export type Phase = (typeof PHASES)[number];

/** Spielerfarben in Vergabereihenfolge (docs/05 §Spielerfarben) – bewusst ohne Grün/Rot. */
export const PLAYER_COLORS = ["blue", "sky", "cyan", "yellow", "ochre", "sand", "steel", "silver"] as const;
export type PlayerColor = (typeof PLAYER_COLORS)[number];

/** Hex-Werte der Spielerfarben (docs/09 §2 „Spielerfarben“). */
export const PLAYER_COLOR_HEX: Readonly<Record<PlayerColor, string>> = Object.freeze({
  blue: "#3F9FF3",
  sky: "#9CD3FF",
  cyan: "#35C8DE",
  yellow: "#F7DF45",
  ochre: "#EBB447",
  sand: "#D8C3A5",
  steel: "#97B0C4",
  silver: "#E3E8EF",
});

/** Erste freie Farbe in Vergabereihenfolge (docs/05); `null`, wenn alle 8 Farben vergeben sind. */
export function pickPlayerColor(taken: Iterable<PlayerColor>): PlayerColor | null {
  const used = new Set(taken);
  return PLAYER_COLORS.find((color) => !used.has(color)) ?? null;
}

/**
 * Status einer Person im Spiel; „resigned“ = aufgegeben (verlassen oder Frist überschritten), „spectator“ = der
 * Host spielt nicht mit und zeigt nur an (Anzeige-Modus, ADR-046) – nie in Reihenfolge, Zügen oder Ergebnis.
 */
export const PLAYER_STATUSES = ["active", "resigned", "spectator"] as const;
export type PlayerStatus = (typeof PLAYER_STATUSES)[number];

/** Codes des Server-Events `notice` (docs/05 §Server → Client). */
export const NOTICE_CODES = ["SERVER_RESTART", "MAINTENANCE", "HOST_CHANGED", "PLAYER_LEFT"] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];

/** Gründe im Server-Event `kicked`. */
export const KICK_REASONS = ["host", "abuse", "inactive"] as const;
export type KickReason = (typeof KICK_REASONS)[number];

/** Feste Meldegründe aus „Fragen ansehen“ (docs/01, docs/04 questionReports). */
export const REPORT_REASONS = ["falsch", "mehrdeutig", "veraltet", "tippfehler", "unpassend"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** Index einer Antwort in der angezeigten Reihenfolge (immer genau 4 Antworten). */
export const ANSWER_INDEXES = [0, 1, 2, 3] as const;
export type AnswerIndex = (typeof ANSWER_INDEXES)[number];

/** Bewertung einer Frage: Daumen hoch (1) oder runter (-1). */
export const RATING_VALUES = [1, -1] as const;
export type RatingValue = (typeof RATING_VALUES)[number];

/** Spielausgang: „draw“ = alle Aktiven gleichauf. */
export const GAME_OUTCOMES = ["win", "draw"] as const;
export type GameOutcome = (typeof GAME_OUTCOMES)[number];

/** Schwierigkeitsstufen der Fragen (docs/08). */
export const DIFFICULTIES = [1, 2, 3, 4, 5] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
