/**
 * Lobby-Einstellungen (docs/01 §Einstellungen, ADR-017): nur Host, nur vor Spielbeginn. Alles andere
 * ist fest wie beim Vorbild (`GAME_RULES`).
 */
import type { Phase } from "./constants.ts";
import { categoryIdSchema } from "./primitives.ts";
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

/** Standard-Antwortzeit in Sekunden (`GAME_RULES.answerTimeMs`). */
const GAME_RULES_ANSWER_SEC = GAME_RULES.answerTimeMs / 1_000;

/**
 * Weiter nach jeder Frage (Auflösung), jeder Kategorie (Zug-Ergebnis) und jedem Zwischenstand (Rundentafel),
 * ADR-045: Sekunden bis es automatisch weitergeht – oder 0 = der Host tippt „Weiter“.
 */
export const ADVANCE_SECONDS = [0, 3, 5, 7, 10, 15, 20, 30] as const;
/** „Host tippt Weiter“ statt automatisch. */
export const MANUAL_ADVANCE = 0;
/** Standard: das Spieltempo aus ADR-044. */
export const ADVANCE_DEFAULTS = { afterQuestionSec: 5, afterTurnSec: 5, afterRoundSec: 7 } as const;
/** Phasen, nach denen es automatisch oder per Host weitergeht. */
export const ADVANCE_PHASES = ["reveal", "turn_summary", "round_board"] as const satisfies readonly Phase[];
export type AdvancePhase = (typeof ADVANCE_PHASES)[number];

/** Phasen, die der Host per `game:continue` beendet: die Frage („Auflösen“, ADR-049) und die Weiter-Phasen. */
export const CONTINUE_PHASES = ["question", ...ADVANCE_PHASES] as const satisfies readonly Phase[];
export type ContinuePhase = (typeof CONTINUE_PHASES)[number];

/** Zeit pro Frage in Sekunden (ADR-049); 0 = „Host“: kein Countdown, der Host tippt „Auflösen“. */
export const ANSWER_SECONDS = [0, 10, 15, 20, 30, 45, 60] as const;
/** Sicherheitsnetz bei „Host“: spätestens dann löst der Server selbst auf (Host weg, Gerät aus). */
export const MANUAL_ANSWER_CAP_MS = 10 * 60_000;

const advanceSeconds = z
  .int()
  .min(0)
  .max(30)
  .refine((value) => (ADVANCE_SECONDS as readonly number[]).includes(value), { message: "keine erlaubte Stufe" });

const answerSeconds = z
  .int()
  .min(0)
  .max(60)
  .refine((value) => (ANSWER_SECONDS as readonly number[]).includes(value), { message: "keine erlaubte Stufe" });

/** Höchstzahl ausgewählter Kategorien (Katalog: 19 – mit Luft für neue). */
export const MAX_SELECTED_CATEGORIES = 50;

/**
 * Kategorien, aus denen angeboten wird (ADR-048): `null` = alle spielbaren, sonst eine Auswahl (mindestens eine,
 * ohne Doppelte). Welche es gibt, prüft der Server gegen den Katalog.
 */
const categoryIdsSchema = z
  .array(categoryIdSchema)
  .min(1)
  .max(MAX_SELECTED_CATEGORIES)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Kategorien doppelt" })
  .nullable();

/**
 * Vollständige Einstellungen einer Lobby (öffentlicher Zustand und Datenbank). Spätere Felder haben
 * Standardwerte: Snapshots und Zustände von vor ADR-045/046/048/049/053 bleiben lesbar.
 */
export const lobbySettingsSchema = z.strictObject({
  rounds: bounded(SETTINGS_BOUNDS.rounds),
  questionsPerCategory: bounded(SETTINGS_BOUNDS.questionsPerCategory),
  maxPlayers: bounded(SETTINGS_BOUNDS.maxPlayers),
  afterQuestionSec: advanceSeconds.default(ADVANCE_DEFAULTS.afterQuestionSec),
  afterTurnSec: advanceSeconds.default(ADVANCE_DEFAULTS.afterTurnSec),
  afterRoundSec: advanceSeconds.default(ADVANCE_DEFAULTS.afterRoundSec),
  /** Spielt der Host mit? `false` = Anzeige-Modus: großer Bildschirm, nur die anderen spielen (ADR-046) */
  hostPlays: z.boolean().default(true),
  categoryIds: categoryIdsSchema.default(null),
  /** Zeit pro Frage (ADR-049); Standard 20 s wie beim Vorbild */
  answerSec: answerSeconds.default(GAME_RULES_ANSWER_SEC),
  /** Alle außer dem Host dürfen Änderungen vorschlagen (ADR-053); der Host schaltet es ab */
  allowSuggestions: z.boolean().default(true),
});
export type LobbySettings = z.output<typeof lobbySettingsSchema>;

export const DEFAULT_LOBBY_SETTINGS: Readonly<LobbySettings> = Object.freeze({
  rounds: SETTINGS_BOUNDS.rounds.default,
  questionsPerCategory: SETTINGS_BOUNDS.questionsPerCategory.default,
  maxPlayers: SETTINGS_BOUNDS.maxPlayers.default,
  ...ADVANCE_DEFAULTS,
  hostPlays: true,
  categoryIds: null,
  answerSec: GAME_RULES_ANSWER_SEC,
  allowSuggestions: true,
});

/** Antwortzeit in ms – `null` bei „Host“ (kein Countdown, ADR-049). */
export function answerWindowMs(settings: Pick<LobbySettings, "answerSec">): number | null {
  return settings.answerSec === MANUAL_ADVANCE ? null : settings.answerSec * 1_000;
}

export type AdvanceSettings = Pick<LobbySettings, "afterQuestionSec" | "afterTurnSec" | "afterRoundSec">;

/** Eingestellte Sekunden für eine Weiter-Phase (0 = Host tippt „Weiter“). */
export function advanceSecondsFor(settings: AdvanceSettings, phase: AdvancePhase): number {
  switch (phase) {
    case "reveal":
      return settings.afterQuestionSec;
    case "turn_summary":
      return settings.afterTurnSec;
    case "round_board":
      return settings.afterRoundSec;
  }
}

/** Dauer der Phase in ms – `null`, wenn der Host „Weiter“ tippt (kein Timer). */
export function advanceDurationMs(settings: AdvanceSettings, phase: AdvancePhase): number | null {
  const seconds = advanceSecondsFor(settings, phase);
  return seconds === MANUAL_ADVANCE ? null : seconds * 1_000;
}

/** Ist `phase` eine Weiter-Phase? */
export function isAdvancePhase(phase: Phase): phase is AdvancePhase {
  return (ADVANCE_PHASES as readonly Phase[]).includes(phase);
}

/** Felder, die der Host ändert und alle anderen vorschlagen dürfen (ADR-053) – alle außer `allowSuggestions`. */
const settingsChangeShape = {
  rounds: bounded(SETTINGS_BOUNDS.rounds).optional(),
  questionsPerCategory: bounded(SETTINGS_BOUNDS.questionsPerCategory).optional(),
  maxPlayers: bounded(SETTINGS_BOUNDS.maxPlayers).optional(),
  afterQuestionSec: advanceSeconds.optional(),
  afterTurnSec: advanceSeconds.optional(),
  afterRoundSec: advanceSeconds.optional(),
  hostPlays: z.boolean().optional(),
  categoryIds: categoryIdsSchema.optional(),
  answerSec: answerSeconds.optional(),
};

/** Einstellungen, die ein Vorschlag ändern kann – in der Reihenfolge des Einstellungen-Sheets (ADR-053). */
export const SUGGESTABLE_SETTINGS = [
  "rounds",
  "questionsPerCategory",
  "maxPlayers",
  "categoryIds",
  "answerSec",
  "afterQuestionSec",
  "afterTurnSec",
  "afterRoundSec",
  "hostPlays",
] as const satisfies readonly (keyof typeof settingsChangeShape)[];
export type SuggestableSetting = (typeof SUGGESTABLE_SETTINGS)[number];

/**
 * Payload von `lobby:update-settings`: nur geänderte Felder, mindestens eines. Ob `maxPlayers` unter
 * die aktuelle Personenzahl fallen darf, entscheidet der Server (fachliche Regel, kein Formatfehler).
 */
export const updateSettingsPayloadSchema = z
  .strictObject({
    ...settingsChangeShape,
    /** Vorschläge der anderen an/aus (ADR-053) – nur der Host */
    allowSuggestions: z.boolean().optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    message: "mindestens eine Einstellung angeben",
  });
export type SettingsUpdate = z.output<typeof updateSettingsPayloadSchema>;

/**
 * Vorgeschlagene Änderungen (ADR-053: `lobby:suggest-settings`, `lobby:accept-suggestion`): wie eine Änderung des
 * Hosts, aber ohne `allowSuggestions`; mindestens ein Feld.
 */
export const settingsChangesSchema = z
  .strictObject(settingsChangeShape)
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
    message: "mindestens eine Einstellung angeben",
  });
export type SettingsChanges = z.output<typeof settingsChangesSchema>;

/** Wendet eine (validierte) Änderung an und liefert neue Einstellungen. */
export function applySettingsUpdate(current: LobbySettings, update: SettingsUpdate): LobbySettings {
  return {
    rounds: update.rounds ?? current.rounds,
    questionsPerCategory: update.questionsPerCategory ?? current.questionsPerCategory,
    maxPlayers: update.maxPlayers ?? current.maxPlayers,
    afterQuestionSec: update.afterQuestionSec ?? current.afterQuestionSec,
    afterTurnSec: update.afterTurnSec ?? current.afterTurnSec,
    afterRoundSec: update.afterRoundSec ?? current.afterRoundSec,
    hostPlays: update.hostPlays ?? current.hostPlays,
    // `null` heißt „alle“ – nur `undefined` lässt die Auswahl unverändert.
    categoryIds: update.categoryIds === undefined ? current.categoryIds : update.categoryIds,
    answerSec: update.answerSec ?? current.answerSec,
    allowSuggestions: update.allowSuggestions ?? current.allowSuggestions,
  };
}

/** Gleicher Einstellungswert; eine Kategorie-Auswahl gilt unabhängig von der Reihenfolge als gleich. */
export function sameSettingValue(a: LobbySettings[SuggestableSetting], b: LobbySettings[SuggestableSetting]): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((entry) => b.includes(entry));
  return a === b;
}

/**
 * Vorschlagbare Felder, in denen `next` von `current` abweicht (ADR-053) – `null`, wenn keins abweicht. Eine
 * Kategorie-Auswahl wird kopiert.
 */
export function settingsChangesBetween(current: LobbySettings, next: LobbySettings): SettingsChanges | null {
  const changes: Partial<Record<SuggestableSetting, LobbySettings[SuggestableSetting]>> = {};
  for (const key of SUGGESTABLE_SETTINGS) {
    const value = next[key];
    if (!sameSettingValue(current[key], value)) changes[key] = Array.isArray(value) ? [...value] : value;
  }
  // Je Schlüssel stammt der Wert aus `next[key]` – passt also zum Feld gleichen Namens.
  return Object.keys(changes).length === 0 ? null : (changes as SettingsChanges);
}
