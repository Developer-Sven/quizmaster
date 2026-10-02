/**
 * Commands an `reduce` (docs/02 §Engine-Muster). Personen-Commands tragen die `guestId` der auslösenden
 * Person (aus dem Socket-Ticket bzw. die synthetische ID eines Dev-Bots) – die Engine löst sie selbst auf
 * und prüft Mitgliedschaft, Rolle und Phase. Shell-Commands (TIMEOUT, OPTIONS_READY, QUESTIONS_READY,
 * LOAD_FAILED) beantworten Effects und tragen deren Token; veraltete Tokens werden still ignoriert.
 *
 * Client-Payloads validiert die Shell vorher mit den Schemas aus `@quizmaster/shared` (CLIENT_EVENTS);
 * die Engine prüft Formate zusätzlich mit denselben Schemas (Defense in Depth).
 */
import {
  type AnswerIndex,
  type CategoryOption,
  type ContinuePhase,
  type GameTimingMode,
  reviewItemSchema,
  type SettingsChanges,
  type SettingsUpdate,
} from "@quizmaster/shared";
import { type QuestionDoc, questionDocSchema } from "@quizmaster/shared/documents";

/** Lobby erstellen (`lobby:create`) – keine `reduce`-Variante, sondern `createLobby(input, ctx)`. */
export interface CreateLobbyInput {
  /** Freier, geprüfter Code (Shell: `generateLobbyCode` + Unique-Index, docs/05 §Lobby-Codes). */
  code: string;
  /** guestId der erstellenden Person (UUID). */
  guestId: string;
  /** Name nach `checkName` (Moderation in der Shell); die Engine prüft das Format erneut. */
  name: string;
  /** `GAME_TIMING` des Servers. */
  timing: GameTimingMode;
}

/** `lobby:join` – nur Phase `lobby`. Ist die Person schon Mitglied, wirkt JOIN wie RECONNECT. */
export interface JoinCommand {
  type: "JOIN";
  guestId: string;
  /** Name nach `checkName`; wird normalisiert und in der Lobby eindeutig gemacht („Mia 2“). */
  name: string;
}

/** `lobby:resume` nach Reconnect – gleicher Platz über die guestId. */
export interface ReconnectCommand {
  type: "RECONNECT";
  guestId: string;
}

/** Letzter Socket der Person in dieser Lobby wurde getrennt (Fristen laufen an). */
export interface DisconnectCommand {
  type: "DISCONNECT";
  guestId: string;
}

/** `lobby:leave` – in der Lobby: austreten; im Spiel: Aufgeben; in `game_over`: austreten. */
export interface LeaveCommand {
  type: "LEAVE";
  guestId: string;
}

/** `lobby:update-settings` – Host, Phase `lobby`. */
export interface UpdateSettingsCommand {
  type: "UPDATE_SETTINGS";
  guestId: string;
  update: SettingsUpdate;
}

/** `lobby:rename` – Mitglied, Phase `lobby`: eigenen Namen ändern (ADR-041); moderiert vom Handler. */
export interface RenameCommand {
  type: "RENAME";
  guestId: string;
  name: string;
}

/** `game:continue` – Host, in einer Weiter-Phase mit „Host tippt Weiter“ (ADR-045). */
export interface ContinueCommand {
  type: "CONTINUE";
  guestId: string;
  /** Phase, die beendet werden soll: Frage auflösen (ADR-049) oder weiter (Doppeltipp überspringt so nichts). */
  phase: ContinuePhase;
}

/** `lobby:transfer-host` – Host gibt die Rolle an eine verbundene Person ab (ADR-047). */
export interface TransferHostCommand {
  type: "TRANSFER_HOST";
  guestId: string;
  targetPlayerId: string;
}

/** `lobby:suggest-settings` – Mitglied außer dem Host, Phase `lobby`, Vorschläge erlaubt (ADR-053). */
export interface SuggestSettingsCommand {
  type: "SUGGEST_SETTINGS";
  guestId: string;
  changes: SettingsChanges;
}

/** `lobby:withdraw-suggestion` – eigenen Vorschlag zurückziehen (ADR-053). */
export interface WithdrawSuggestionCommand {
  type: "WITHDRAW_SUGGESTION";
  guestId: string;
}

/** `lobby:accept-suggestion` – Host übernimmt einen offenen Vorschlag, ggf. in eigener Fassung (ADR-053). */
export interface AcceptSuggestionCommand {
  type: "ACCEPT_SUGGESTION";
  guestId: string;
  suggestionId: string;
  /** Fassung des Hosts; ohne: wie vorgeschlagen */
  changes?: SettingsChanges;
}

/** `lobby:decline-suggestion` – Host lehnt einen offenen Vorschlag ab (ADR-053). */
export interface DeclineSuggestionCommand {
  type: "DECLINE_SUGGESTION";
  guestId: string;
  suggestionId: string;
}

/** `game:end` – Host beendet das laufende Spiel für alle mit dem aktuellen Stand (ADR-051). */
export interface EndGameCommand {
  type: "END_GAME";
  guestId: string;
}

/** `lobby:kick` – Host, nicht sich selbst; entfernt + sperrt die Person für diese Lobby. */
export interface KickCommand {
  type: "KICK";
  guestId: string;
  /** Öffentliche playerId der zu entfernenden Person. */
  targetPlayerId: string;
}

/** `lobby:start` – Host, Phase `lobby`, ≥ 2 verbundene Personen (Bots zählen). */
export interface StartCommand {
  type: "START";
  guestId: string;
}

/** `game:rematch` – Host, Phase `game_over`; gleiche Personen, gleiche Einstellungen, neue Reihenfolge. */
export interface RematchCommand {
  type: "REMATCH";
  guestId: string;
}

/** `dev:add-bot` – Host, Phase `lobby` (die Shell prüft DEV_BOTS_ENABLED). */
export interface AddBotCommand {
  type: "ADD_BOT";
  guestId: string;
}

/** `game:pick` – wählende Person, Phase `category_pick`, nur eine der 3 Optionen. */
export interface PickCommand {
  type: "PICK";
  guestId: string;
  categoryId: string;
}

/** `game:answer` – Phase `question`, 1× pro Person und Frage, `startsAt ≤ now ≤ deadline + Kulanz`. */
export interface AnswerCommand {
  type: "ANSWER";
  guestId: string;
  /** Instanz-ID der Frage (nicht die DB-ID). */
  questionId: string;
  choice: AnswerIndex;
}

/** Fälliger Timer (Effect `scheduleTimer`); unbekannte Tokens sind veraltet und werden ignoriert. */
export interface TimeoutCommand {
  type: "TIMEOUT";
  token: number;
}

/** Antwort auf `offerCategories`: genau 3 verschiedene Kategorien (z. B. aus `offerCategories()`). */
export interface OptionsReadyCommand {
  type: "OPTIONS_READY";
  token: number;
  options: readonly CategoryOption[];
}

/**
 * Frage, wie die Shell sie aus `questions` lädt (Volldokument oder Projektion). Weitere Felder
 * (`source`, `stats`, `status` …) werden beim Validieren verworfen und gelangen nie in den Zustand.
 */
export type QuestionInput = Pick<
  QuestionDoc,
  "_id" | "category" | "difficulty" | "displayOrder" | "prompt" | "answers" | "explanation" | "media"
>;

/**
 * Schema für `QuestionInput`: DB-Regeln aus `questionDocSchema` (ID-Format, Kategorie, Schwierigkeit)
 * plus die Payload-Grenzen des Rückblicks (`reviewItemSchema`), damit jede gestellte Frage später auch
 * gültig an Clients geht. Nicht strikt: unbekannte Felder werden entfernt.
 */
export const questionInputSchema = questionDocSchema
  .pick({ _id: true, category: true, difficulty: true, displayOrder: true })
  .extend({
    prompt: reviewItemSchema.shape.prompt,
    answers: reviewItemSchema.shape.answers,
    explanation: reviewItemSchema.shape.explanation,
    media: reviewItemSchema.shape.media,
  });

/** Antwort auf `loadQuestions`: 1 … K Fragen der gewählten Kategorie in Anzeigereihenfolge (Schwierigkeit aufsteigend). */
export interface QuestionsReadyCommand {
  type: "QUESTIONS_READY";
  token: number;
  questions: readonly QuestionInput[];
}

/** Die Shell kann `offerCategories`/`loadQuestions` endgültig nicht erfüllen → Spiel endet mit Ergebnis. */
export interface LoadFailedCommand {
  type: "LOAD_FAILED";
  token: number;
  /** Nur für Logs. */
  reason: string;
}

export type Command =
  | JoinCommand
  | ReconnectCommand
  | DisconnectCommand
  | LeaveCommand
  | UpdateSettingsCommand
  | RenameCommand
  | ContinueCommand
  | TransferHostCommand
  | SuggestSettingsCommand
  | WithdrawSuggestionCommand
  | AcceptSuggestionCommand
  | DeclineSuggestionCommand
  | EndGameCommand
  | KickCommand
  | StartCommand
  | RematchCommand
  | AddBotCommand
  | PickCommand
  | AnswerCommand
  | TimeoutCommand
  | OptionsReadyCommand
  | QuestionsReadyCommand
  | LoadFailedCommand;

export type CommandType = Command["type"];

/** Commands, die die Shell selbst erzeugt (keine Aktion einer Person, keine Aktivität). */
export const SHELL_COMMAND_TYPES = ["TIMEOUT", "OPTIONS_READY", "QUESTIONS_READY", "LOAD_FAILED"] as const;

export function isShellCommand(
  command: Command,
): command is TimeoutCommand | OptionsReadyCommand | QuestionsReadyCommand | LoadFailedCommand {
  return (SHELL_COMMAND_TYPES as readonly string[]).includes(command.type);
}
