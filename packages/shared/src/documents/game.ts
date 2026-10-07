import { z } from "zod";
import { GAME_OUTCOMES, PLAYER_COLORS, PLAYER_STATUSES } from "../constants.ts";
import { QUESTION_ID_REGEX } from "../content/questions.ts";
import {
  answerIndexSchema,
  categoryIdSchema,
  displayNameSchema,
  lobbyCodeSchema,
  playerIdSchema,
} from "../primitives.ts";
import { GAME_RULES, lobbySettingsSchema } from "../settings.ts";
import { documentIdSchema, ownerGuestIdSchema } from "./lobby.ts";

/** Mischung einer Frage: Index in `answers` (Repo-Reihenfolge) je angezeigter Position. */
export const shownOrderSchema = z
  .tuple([answerIndexSchema, answerIndexSchema, answerIndexSchema, answerIndexSchema])
  .refine((order) => new Set(order).size === 4, { message: "shownOrder muss eine Permutation von 0–3 sein" });

export const gamePlayerSchema = z.object({
  playerId: playerIdSchema,
  guestId: ownerGuestIdSchema,
  name: displayNameSchema,
  color: z.enum(PLAYER_COLORS),
  isBot: z.boolean(),
  place: z.int().min(1),
  score: z.int().min(0),
  status: z.enum(PLAYER_STATUSES),
});

export const gameAnswerSchema = z.object({
  playerId: playerIdSchema,
  /** Angezeigte Position (0–3) oder `null` = keine Antwort. */
  choice: answerIndexSchema.nullable(),
  /** Antwortzeit ab `startsAt` in ms; `null` ohne Antwort. */
  ms: z.int().min(0).nullable(),
  correct: z.boolean(),
});

export const gameTurnSchema = z.object({
  round: z.int().min(1),
  pickerId: playerIdSchema,
  /** Angebotene Kategorien: 3 – bei einer Auswahl des Hosts auch 1–2 (ADR-048) */
  offered: z.array(categoryIdSchema).min(1).max(GAME_RULES.categoryOptionsPerTurn),
  categoryId: categoryIdSchema,
  /** „fixed“: nur eine Kategorie erlaubt, keine Wahl (ADR-048) */
  pickedBy: z.enum(["player", "timeout", "fixed"]),
  questions: z.array(
    z.object({
      /** DB-ID der Frage (nicht die Instanz-ID aus dem Spiel). */
      questionId: z.string().regex(QUESTION_ID_REGEX),
      shownOrder: shownOrderSchema,
      answers: z.array(gameAnswerSchema),
    }),
  ),
});

/** games – abgeschlossene Spiele (TTL 90 Tage). */
export const gameDocSchema = z.object({
  _id: documentIdSchema,
  lobbyId: documentIdSchema,
  code: lobbyCodeSchema,
  startedAt: z.date(),
  endedAt: z.date(),
  /** endedAt + 90 Tage (TTL). */
  expiresAt: z.date(),
  settings: lobbySettingsSchema,
  outcome: z.enum(GAME_OUTCOMES),
  players: z.array(gamePlayerSchema),
  /** Ein Eintrag pro Zug (Kategoriewahl). */
  turns: z.array(gameTurnSchema),
});
export type GameDoc = z.output<typeof gameDocSchema>;
