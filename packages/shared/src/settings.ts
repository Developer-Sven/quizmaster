/**
 * Lobby-Einstellungen (docs/01 §Einstellungen, ADR-017): nur Host, nur vor Spielbeginn. Alles andere
 * ist fest wie beim Vorbild (`GAME_RULES`).
 */
import * as z from "./zod.ts";

/** Einstellbare Werte mit Grenzen und Standard. */
export const SETTINGS_BOUNDS = {
  rounds: { min: 1, max: 10, default: 3 },
  questionsPerCategory: { min: 1, max: 10, default: 3 },
  maxPlayers: { min: 2, max: 8, default: 8 },
} as const;

/** Feste Spielregeln (nicht einstellbar). Zeiten in ms, passend zu `TIMINGS.normal`. */
export const GAME_RULES = {
  answersPerQuestion: 4,
  categoryOptionsPerTurn: 3,
  answerTimeMs: 20_000,
  categoryPickTimeMs: 15_000,
  pointsPerCorrectAnswer: 1,
  /** „ab 2 verbundenen Personen“ startbar; weniger als 2 Aktive beenden ein laufendes Spiel. */
  minPlayers: 2,
  maxPlayersPerLobby: SETTINGS_BOUNDS.maxPlayers.max,
  /** Dev-Bots: Host fügt bis zu 7 hinzu (docs/05 §Dev-Bots). */
  maxBotsPerLobby: 7,
  /** Gesehene Fragen je Gast, die vermieden werden (docs/01 §Fragenauswahl). */
  recentQuestionsRemembered: 1_000,
  /** Pro Gast max. 1 aktive gehostete Lobby. */
  maxActiveHostedLobbiesPerGuest: 1,
} as const;

const bounded = (bounds: { readonly min: number; readonly max: number }) => z.int().min(bounds.min).max(bounds.max);

/** Vollständige Einstellungen einer Lobby (öffentlicher Zustand und Datenbank). */
export const lobbySettingsSchema = z.strictObject({
  rounds: bounded(SETTINGS_BOUNDS.rounds),
  questionsPerCategory: bounded(SETTINGS_BOUNDS.questionsPerCategory),
  maxPlayers: bounded(SETTINGS_BOUNDS.maxPlayers),
});
export type LobbySettings = z.output<typeof lobbySettingsSchema>;

export const DEFAULT_LOBBY_SETTINGS: Readonly<LobbySettings> = Object.freeze({
  rounds: SETTINGS_BOUNDS.rounds.default,
  questionsPerCategory: SETTINGS_BOUNDS.questionsPerCategory.default,
  maxPlayers: SETTINGS_BOUNDS.maxPlayers.default,
});

/**
 * Payload von `lobby:update-settings`: nur geänderte Felder, mindestens eines. Ob `maxPlayers` unter
 * die aktuelle Personenzahl fallen darf, entscheidet der Server (fachliche Regel, kein Formatfehler).
 */
export const updateSettingsPayloadSchema = z
  .strictObject({
    rounds: bounded(SETTINGS_BOUNDS.rounds).optional(),
    questionsPerCategory: bounded(SETTINGS_BOUNDS.questionsPerCategory).optional(),
    maxPlayers: bounded(SETTINGS_BOUNDS.maxPlayers).optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    message: "mindestens eine Einstellung angeben",
  });
export type SettingsUpdate = z.output<typeof updateSettingsPayloadSchema>;

/** Wendet eine (validierte) Änderung an und liefert neue Einstellungen. */
export function applySettingsUpdate(current: LobbySettings, update: SettingsUpdate): LobbySettings {
  return {
    rounds: update.rounds ?? current.rounds,
    questionsPerCategory: update.questionsPerCategory ?? current.questionsPerCategory,
    maxPlayers: update.maxPlayers ?? current.maxPlayers,
  };
}
