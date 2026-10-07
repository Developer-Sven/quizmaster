/**
 * Server→Client-Payloads (docs/05 §Zustände). Alle Objekte sind `strictObject`: zusätzliche Felder
 * (etwa `guestId`, `source` oder ein vorzeitiges `correct`) lassen die Prüfung scheitern – so lassen sich
 * die Invarianten aus docs/06 in Tests der Engine und des Realtime-Servers direkt absichern.
 */

import {
  GAME_OUTCOMES,
  KICK_REASONS,
  NOTICE_CODES,
  PHASES,
  PLAYER_COLORS,
  PLAYER_STATUSES,
  RATING_VALUES,
  SUGGESTION_STATUSES,
} from "./constants.ts";
import {
  answerIndexSchema,
  categoryIdSchema,
  displayNameSchema,
  hexColorSchema,
  iconNameSchema,
  lobbyCodeSchema,
  mediaSchema,
  playerIdSchema,
  questionInstanceIdSchema,
  suggestionIdSchema,
  timestampSchema,
} from "./primitives.ts";
import { GAME_RULES, lobbySettingsSchema, SETTINGS_BOUNDS, settingsChangesSchema } from "./settings.ts";
import * as z from "./zod.ts";

const MAX_PLAYERS = GAME_RULES.maxPlayersPerLobby;
/** Züge je Spiel höchstens: Runden × Personen. */
const MAX_TURNS = SETTINGS_BOUNDS.rounds.max * MAX_PLAYERS;
const MAX_QUESTIONS_PER_TURN = SETTINGS_BOUNDS.questionsPerCategory.max;
/** Obergrenze für Fragetexte in Payloads (Inhaltsregel: ≤ 140 Zeichen, docs/08). */
const PROMPT_MAX = 500;
/** Obergrenze für Antworten in Payloads (Inhaltsregel: ≤ 40 Zeichen). */
const ANSWER_MAX = 200;
/** Obergrenze für Erklärungen in Payloads (Inhaltsregel: ≤ 200 Zeichen). */
const EXPLANATION_MAX = 500;

const answerTextSchema = z.string().min(1).max(ANSWER_MAX);
/** Genau 4 Antworten, bereits in Anzeigereihenfolge (gemischt bzw. aufsteigend sortiert). */
export const shownAnswersSchema = z.tuple([answerTextSchema, answerTextSchema, answerTextSchema, answerTextSchema]);

/** playerId → gewählte Antwort (`null` = keine Antwort). Nur ab Phase `reveal` bzw. im Rückblick. */
export const picksSchema = z.record(playerIdSchema, answerIndexSchema.nullable());

export const publicPlayerSchema = z.strictObject({
  /** playerId – öffentlich, zufällig, NICHT die guestId. */
  id: playerIdSchema,
  name: displayNameSchema,
  color: z.enum(PLAYER_COLORS),
  isHost: z.boolean(),
  /** Nur Dev (DEV_BOTS_ENABLED). */
  isBot: z.boolean(),
  connected: z.boolean(),
  status: z.enum(PLAYER_STATUSES),
  /** Punkte gesamt – nur aus aufgelösten Fragen. */
  score: z.int().min(0),
});
export type PublicPlayer = z.output<typeof publicPlayerSchema>;

export const categoryOptionSchema = z.strictObject({
  id: categoryIdSchema,
  name: z.string().min(1).max(64),
  icon: iconNameSchema,
  color: hexColorSchema,
});
export type CategoryOption = z.output<typeof categoryOptionSchema>;

/** Eine Zeile der Tafel = ein Zug; `results` enthält NUR aufgelöste Fragen. */
export const boardRowSchema = z.strictObject({
  /** Runde, 1-basiert. */
  round: z.int().min(1),
  pickerId: playerIdSchema,
  categoryId: categoryIdSchema,
  /** playerId → je Frage richtig (`true`) / falsch (`false`) / keine Antwort (`null`). */
  results: z.record(playerIdSchema, z.array(z.boolean().nullable()).max(MAX_QUESTIONS_PER_TURN)),
});
export type BoardRow = z.output<typeof boardRowSchema>;

export const progressSchema = z.strictObject({
  /** Aktuelle Runde, 1-basiert (1 … rounds). */
  round: z.int().min(1),
  rounds: z.int().min(1),
  /** Aktueller Zug in der Runde, 1-basiert (1 … turnsPerRound). */
  turn: z.int().min(1),
  turnsPerRound: z.int().min(1),
});

export const turnSchema = z.strictObject({
  pickerId: playerIdSchema,
  /** 3 Optionen – bei begrenzten Kategorien auch 1–2 (ADR-048; genau 1 = feste Kategorie, keine Wahl) */
  options: z.array(categoryOptionSchema).min(1).max(GAME_RULES.categoryOptionsPerTurn),
  /** Gewählte Kategorie – erst nach der Wahl, vorher `null`. */
  categoryId: categoryIdSchema.nullable(),
});

/**
 * Laufende Frage. `correct`, `picks` und `explanation` sind optional und dürfen erst ab Phase
 * `reveal` gesetzt sein (docs/05 §Fairness, docs/06 Invariante 1) – der Server lässt sie vorher weg.
 */
export const publicQuestionSchema = z
  .strictObject({
    /** Instanz-ID in diesem Spiel (nicht die DB-ID). */
    id: questionInstanceIdSchema,
    /** „Frage x von K“: 1-basiert, 1 … total. */
    index: z.int().min(1),
    total: z.int().min(1).max(MAX_QUESTIONS_PER_TURN),
    categoryId: categoryIdSchema,
    prompt: z.string().min(1).max(PROMPT_MAX),
    answers: shownAnswersSchema,
    media: mediaSchema,
    /** Ab hier sichtbar (Serverzeit). */
    startsAt: timestampSchema,
    /** Antwortschluss (Serverzeit); Kulanz siehe `Timings.deadlineGraceMs`. */
    deadline: timestampSchema,
    /** Wer geantwortet hat (nicht was). */
    answeredBy: z.array(playerIdSchema).max(MAX_PLAYERS),
    correct: answerIndexSchema.optional(),
    picks: picksSchema.optional(),
    explanation: z.string().max(EXPLANATION_MAX).nullable().optional(),
  })
  .refine((question) => question.index <= question.total, { message: "index > total", path: ["index"] });
export type PublicQuestion = z.output<typeof publicQuestionSchema>;

export const rankingEntrySchema = z.strictObject({
  playerId: playerIdSchema,
  /** Gleiche Punkte = gleicher Platz; „Aufgegeben“ hinter allen Aktiven. */
  place: z.int().min(1),
  score: z.int().min(0),
  status: z.enum(PLAYER_STATUSES),
});

export const gameResultsSchema = z.strictObject({
  ranking: z.array(rankingEntrySchema).max(MAX_PLAYERS),
  /** „draw“ = alle Aktiven gleichauf. */
  outcome: z.enum(GAME_OUTCOMES),
});

/**
 * Vorschlag einer Person für die Einstellungen (ADR-053): nur in der Lobby, je Person höchstens einer. Bleibt nach
 * der Entscheidung des Hosts als „übernommen“/„abgelehnt“ stehen, bis die Person neu vorschlägt, geht oder das
 * Spiel beginnt – so erfährt sie das Ergebnis.
 */
export const settingsSuggestionSchema = z.strictObject({
  id: suggestionIdSchema,
  playerId: playerIdSchema,
  /** nur Felder, die beim Einreichen vom damaligen Stand abwichen */
  changes: settingsChangesSchema,
  status: z.enum(SUGGESTION_STATUSES),
  /** Serverzeit des Einreichens */
  at: timestampSchema,
});
export type SettingsSuggestion = z.output<typeof settingsSuggestionSchema>;

/** Vollständiger öffentlicher Snapshot einer Lobby (Event `lobby:state`, `rev` steigt). */
export const publicLobbyStateSchema = z.strictObject({
  rev: z.int().min(0),
  protocolVersion: z.int().min(1),
  code: lobbyCodeSchema,
  phase: z.enum(PHASES),
  /** Serverzeit (ms). */
  phaseStartedAt: timestampSchema,
  /** Serverzeit; `null` = wartet auf eine Aktion (Lobby, Spielende). */
  phaseEndsAt: timestampSchema.nullable(),
  settings: lobbySettingsSchema,
  players: z.array(publicPlayerSchema).max(MAX_PLAYERS),
  /** Reihenfolge der Kategoriewahl (playerIds). */
  order: z.array(playerIdSchema).max(MAX_PLAYERS).nullable(),
  progress: progressSchema.nullable(),
  turn: turnSchema.nullable(),
  question: publicQuestionSchema.nullable(),
  /** Bisherige Züge (nur aufgelöste Fragen). */
  board: z.array(boardRowSchema).max(MAX_TURNS),
  results: gameResultsSchema.nullable(),
  /** Eingefroren (ADR-057): von keiner aktiven Person kommt etwas an – die Spielzeit steht. */
  frozen: z.boolean(),
  /** Vorschläge für die Einstellungen (ADR-053) – außerhalb der Lobby leer. */
  suggestions: z.array(settingsSuggestionSchema).max(MAX_PLAYERS),
});
export type PublicLobbyState = z.output<typeof publicLobbyStateSchema>;

/** Privater Zustand nur für die betroffene Person (Event `lobby:self`). */
export const privatePlayerStateSchema = z.strictObject({
  playerId: playerIdSchema,
  isHost: z.boolean(),
  /** Bin ich gerade die wählende Person? */
  canPick: z.boolean(),
  myAnswer: z.strictObject({ questionId: questionInstanceIdSchema, choice: answerIndexSchema }).nullable(),
});
export type PrivatePlayerState = z.output<typeof privatePlayerStateSchema>;

/** Eintrag im Rückblick „Fragen ansehen“ (Ack von `game:review`, nur in `game_over`). */
export const reviewItemSchema = z.strictObject({
  questionId: questionInstanceIdSchema,
  categoryId: categoryIdSchema,
  prompt: z.string().min(1).max(PROMPT_MAX),
  /** Flaggen-Fragen auch im Rückblick zeigen. */
  media: mediaSchema,
  /** Reihenfolge wie im Spiel. */
  answers: shownAnswersSchema,
  correct: answerIndexSchema,
  explanation: z.string().max(EXPLANATION_MAX).nullable(),
  picks: picksSchema,
  myRating: z.literal(RATING_VALUES).nullable(),
  myReported: z.boolean(),
});
export type ReviewItem = z.output<typeof reviewItemSchema>;

/** Höchstzahl der Fragen eines Spiels (10 Runden × 8 Personen × 10 Fragen). */
export const MAX_QUESTIONS_PER_GAME = MAX_TURNS * MAX_QUESTIONS_PER_TURN;

export const reviewListSchema = z.array(reviewItemSchema).max(MAX_QUESTIONS_PER_GAME);

export const noticeSchema = z.strictObject({ code: z.enum(NOTICE_CODES) });
export type Notice = z.output<typeof noticeSchema>;

export const kickedSchema = z.strictObject({ reason: z.enum(KICK_REASONS) });
export type Kicked = z.output<typeof kickedSchema>;
