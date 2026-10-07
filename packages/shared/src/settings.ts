/**
 * Lobby-Einstellungen (docs/01 §Einstellungen, ADR-017): nur Host, nur vor Spielbeginn. Alles andere
 * ist fest wie beim Vorbild (`GAME_RULES`).
 */
import { DIFFICULTIES, type Phase } from "./constants.ts";
import { DIFFICULTY_BASES, DIFFICULTY_ORDERS } from "./difficulty.ts";
import { categoryIdSchema } from "./primitives.ts";
import * as z from "./zod.ts";

/** Einstellbare Werte mit Grenzen und Standard. */
export const SETTINGS_BOUNDS = {
  rounds: { min: 1, max: 10, default: 3 },
  questionsPerCategory: { min: 1, max: 10, default: 3 },
  maxPlayers: { min: 2, max: 8, default: 8 },
} as const;

/**
 * Feste Spielregeln (nicht einstellbar), jede mit Wirkung im Code. Weitere feste Werte haben ihre eine Quelle
 * dort, wo sie wirken: vier Antworten `ANSWER_INDEXES` (constants.ts), Zeiten `TIMINGS` (timings.ts), gemerkte
 * gesehene Fragen `RECENT_QUESTION_IDS_MAX` (documents), eine gehostete Lobby je Gast `QUOTAS` (limits.ts).
 */
export const GAME_RULES = {
  /** Kategorien zur Wahl je Zug (docs/01); mit einer Auswahl des Hosts auch weniger (ADR-048). */
  categoryOptionsPerTurn: 3,
  /** Standard der Antwortzeit (`answerSec`, ADR-049) – 20 s wie beim Vorbild, gleich `TIMINGS.normal.answerMs`. */
  answerTimeMs: 20_000,
  pointsPerCorrectAnswer: 1,
  /** „ab 2 verbundenen Personen“ startbar; weniger als 2 Aktive beenden ein laufendes Spiel. */
  minPlayers: 2,
  maxPlayersPerLobby: SETTINGS_BOUNDS.maxPlayers.max,
  /** Dev-Bots: Host fügt bis zu 7 hinzu (docs/05 §Dev-Bots). */
  maxBotsPerLobby: 7,
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
export const ANSWER_SECONDS = [0, 3, 5, 10, 15, 20, 30, 45, 60] as const;
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

/**
 * Wie die Kategorie eines Zuges entsteht (ADR-056): `pick` – wer dran ist, wählt aus drei (bei genau einer
 * ausgewählten Kategorie entfällt die Wahl); `sequence` – keine Wahl, Runde 1 spielt die erste ausgewählte Kategorie,
 * Runde 2 die zweite … (mindestens zwei, die Runden folgen deren Anzahl).
 */
export const CATEGORY_MODES = ["pick", "sequence"] as const;
export type CategoryMode = (typeof CATEGORY_MODES)[number];

/** Schwierigkeitsstufe 1 (sehr leicht) bis 5 (sehr schwer). */
const difficultyLevel = z.literal(DIFFICULTIES);

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
 * Standardwerte: Snapshots und Zustände von vor ADR-045/046/048/049/053/055/056 bleiben lesbar.
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
  /** Schwierigkeit von–bis (ADR-055); `difficultyMin` ≤ `difficultyMax` prüft der Server */
  difficultyMin: difficultyLevel.default(1),
  difficultyMax: difficultyLevel.default(5),
  /** Stufe wechselt pro Frage oder pro Kategorie (ADR-055) */
  difficultyBasis: z.enum(DIFFICULTY_BASES).default("question"),
  /** aufsteigend oder zufällig (ADR-055) */
  difficultyOrder: z.enum(DIFFICULTY_ORDERS).default("ascending"),
  /** Kategorien wählen oder der Reihe nach spielen (ADR-056) */
  categoryMode: z.enum(CATEGORY_MODES).default("pick"),
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
  difficultyMin: 1,
  difficultyMax: 5,
  difficultyBasis: "question",
  difficultyOrder: "ascending",
  categoryMode: "pick",
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
  difficultyMin: difficultyLevel.optional(),
  difficultyMax: difficultyLevel.optional(),
  difficultyBasis: z.enum(DIFFICULTY_BASES).optional(),
  difficultyOrder: z.enum(DIFFICULTY_ORDERS).optional(),
  categoryMode: z.enum(CATEGORY_MODES).optional(),
};

/** Einstellungen, die ein Vorschlag ändern kann – in der Reihenfolge des Einstellungen-Sheets (ADR-053). */
export const SUGGESTABLE_SETTINGS = [
  "rounds",
  "questionsPerCategory",
  "maxPlayers",
  "categoryIds",
  "categoryMode",
  "difficultyMin",
  "difficultyMax",
  "difficultyBasis",
  "difficultyOrder",
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

/**
 * Kategorien der Reihe nach (ADR-056) gibt es nur mit mindestens zwei ausgewählten Kategorien – sonst wieder Wahl –,
 * und die Runden folgen dann deren Anzahl (jede Kategorie genau eine Runde; mehr als 10 lehnt der Server ab).
 */
function withCategoryMode(settings: LobbySettings): LobbySettings {
  if (settings.categoryMode !== "sequence") return settings;
  const count = settings.categoryIds?.length ?? 0;
  if (count < 2) return { ...settings, categoryMode: "pick" };
  return { ...settings, rounds: Math.min(count, SETTINGS_BOUNDS.rounds.max) };
}

/** Wählt jemand die Kategorie? Nicht bei genau einer ausgewählten Kategorie und nicht „der Reihe nach“ (ADR-056). */
export function hasCategoryPick(settings: {
  categoryIds?: readonly string[] | null;
  categoryMode?: CategoryMode;
}): boolean {
  return settings.categoryMode !== "sequence" && settings.categoryIds?.length !== 1;
}

/** Züge je Runde: jede Person wählt einmal – ohne Wahl genau einer (eine Runde = eine Kategorie, ADR-056). */
export function turnsPerRound(
  players: number,
  settings: { categoryIds?: readonly string[] | null; categoryMode?: CategoryMode },
): number {
  return hasCategoryPick(settings) ? players : Math.min(players, 1);
}

/** Wendet eine (validierte) Änderung an und liefert neue Einstellungen. */
export function applySettingsUpdate(current: LobbySettings, update: SettingsUpdate): LobbySettings {
  return withCategoryMode({
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
    difficultyMin: update.difficultyMin ?? current.difficultyMin,
    difficultyMax: update.difficultyMax ?? current.difficultyMax,
    difficultyBasis: update.difficultyBasis ?? current.difficultyBasis,
    difficultyOrder: update.difficultyOrder ?? current.difficultyOrder,
    categoryMode: update.categoryMode ?? current.categoryMode,
  });
}

/**
 * Gleicher Einstellungswert. Eine Kategorie-Auswahl gilt unabhängig von der Reihenfolge als gleich – außer mit
 * `ordered`: „Der Reihe nach“ (ADR-056) spielt Runde r die r-te Kategorie, dort ist die Reihenfolge Inhalt.
 */
export function sameSettingValue(
  a: LobbySettings[SuggestableSetting],
  b: LobbySettings[SuggestableSetting],
  ordered = false,
): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return ordered ? a.every((entry, index) => entry === b[index]) : a.every((entry) => b.includes(entry));
  }
  return a === b;
}

/**
 * Vorschlagbare Felder, in denen `next` von `current` abweicht (ADR-053) – `null`, wenn keins abweicht. Eine
 * Kategorie-Auswahl wird kopiert; spielt `next` die Kategorien der Reihe nach (ADR-056), zählt ihre Reihenfolge.
 */
export function settingsChangesBetween(current: LobbySettings, next: LobbySettings): SettingsChanges | null {
  const ordered = next.categoryMode === "sequence";
  const changes: Partial<Record<SuggestableSetting, LobbySettings[SuggestableSetting]>> = {};
  for (const key of SUGGESTABLE_SETTINGS) {
    const value = next[key];
    if (!sameSettingValue(current[key], value, ordered)) changes[key] = Array.isArray(value) ? [...value] : value;
  }
  // Je Schlüssel stammt der Wert aus `next[key]` – passt also zum Feld gleichen Namens.
  return Object.keys(changes).length === 0 ? null : (changes as SettingsChanges);
}
