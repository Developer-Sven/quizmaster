/**
 * @quizmaster/game-engine – reine, serverautoritative Spiel-State-Machine (docs/02, ADR-003).
 * Keine I/O, keine Uhr, kein Zufall ohne übergebenen RNG. Produktions-RNG (node:crypto) über den Subpath
 * „@quizmaster/game-engine/crypto-rng“; dieser Haupt-Export hat keine `node:`-Importe.
 *
 * Vertrag für die Shell (Realtime-LobbyActor):
 * - Erstellen: `createLobby({ code, guestId, name, timing }, { now, rng })` (Name vorher mit `checkName`
 *   moderieren). Danach je Lobby strikt seriell: `reduce(state, command, { now: Date.now(), rng })`.
 * - `ok: false` → Fehler-Ack mit `error.code` (Zustand unverändert). `ok: true` → neuen Zustand übernehmen,
 *   Ack senden (ANSWER: `{ accepted: true }`, nie richtig/falsch), dann `effects` in Reihenfolge ausführen:
 *   `kick` (kicked senden, Socket aus dem Raum) · `broadcast` (`toPublicState`) · `sendPrivate`
 *   (`toPrivateState` an die Sockets der guestId) · `notice` · `cancelTimer`/`scheduleTimer` (bei Fälligkeit
 *   `TIMEOUT { token }` einreihen) · `offerCategories` (`offerCategories()` → OPTIONS_READY, sonst LOAD_FAILED)
 *   · `loadQuestions` (`drawQuestions()`, Volldokumente per `$in` laden → QUESTIONS_READY, endgültiger Fehler →
 *   LOAD_FAILED) · `gameFinished` (games + Statistik in einer Transaktion) · `persist` (`toLobbySnapshot`,
 *   entprellt) · `closeLobby` (Timer löschen, aus der Registry entfernen).
 * - Folge-Commands (TIMEOUT, OPTIONS_READY, QUESTIONS_READY, LOAD_FAILED) in dieselbe Warteschlange einreihen;
 *   veraltete Tokens ignoriert die Engine. Jede Anfrage binnen `SHELL_REQUEST_TIMEOUT_MS` beantworten (DB-
 *   Aufrufe dafür kürzer befristen). Lehnt die Engine eine Antwort ab (`ok: false`), bleibt die Anfrage bis
 *   zur Frist offen: korrigiert erneut antworten oder LOAD_FAILED senden. Läuft die Frist ab (Timer
 *   `request`), beendet die Engine das Spiel selbst mit `load_failed`; spätere Antworten sind veraltet.
 * - Neuer Socket: vor JOIN/RECONNECT dem Raum hinzufügen (die Engine sendet dann Zustand + privaten Zustand).
 *   DISCONNECT erst, wenn der letzte Socket der Person getrennt ist.
 * - Bots: nach jedem Command mit geändertem `state.phaseToken` `planBotMoves(state, rng)` neu planen
 *   (alte Bot-Timer verwerfen) und die Commands zum Zeitpunkt `at` einreihen.
 * - Gesehene Fragen: beim Spielstart `recentQuestionIds` aller Menschen laden → `buildSeenQuestions`.
 * - `question:rate`/`report`: `findShownQuestion(state, instanceId)` liefert die DB-ID (sonst ablehnen);
 *   `game:review`: `toReviewItems(state, playerId, { ratings, reported })` (Bewertungen je DB-ID).
 * - Schließt die Lobby während eines Spiels (niemand verbunden / keine Menschen mehr), wird das Spiel
 *   abgebrochen – ohne `gameFinished`.
 */
import { PROTOCOL_VERSION } from "@quizmaster/shared";

/** Protokollversion, gegen die die Engine gebaut ist. */
export const ENGINE_PROTOCOL_VERSION: number = PROTOCOL_VERSION;

export { type ArrangedAnswers, arrangeAnswers, parseDisplayNumber } from "./answers.ts";
export {
  BOT_ACCURACY,
  BOT_ANSWER_DELAY_SHARE,
  BOT_PICK_DELAY_SHARE,
  type BotMove,
  botAccuracy,
  botAnswerDelayMs,
  botPickDelayMs,
  chooseBotAnswer,
  chooseBotCategory,
  planBotMoves,
} from "./bot-strategy.ts";
export {
  type AddBotCommand,
  type AnswerCommand,
  type Command,
  type CommandType,
  type CreateLobbyInput,
  type DisconnectCommand,
  isShellCommand,
  type JoinCommand,
  type KickCommand,
  type LeaveCommand,
  type LoadFailedCommand,
  type OptionsReadyCommand,
  type PickCommand,
  type QuestionInput,
  type QuestionsReadyCommand,
  questionInputSchema,
  type ReconnectCommand,
  type RematchCommand,
  SHELL_COMMAND_TYPES,
  type StartCommand,
  type TimeoutCommand,
  type UpdateSettingsCommand,
} from "./commands.ts";
export type { EngineContext } from "./context.ts";
export {
  EFFECT_ORDER,
  type Effect,
  type EffectType,
  type GameStats,
  type GuestGameStats,
  PERSIST_REASONS,
  type PersistReason,
  type QuestionGameStats,
  type TurnRef,
} from "./effects.ts";
export { SHELL_REQUEST_TIMEOUT_MS } from "./flow.ts";
export { toPrivateState, toPublicState } from "./projection.ts";
export { computeOutcome, computeResults, type RankingInput } from "./ranking.ts";
export { buildGameDoc, buildGameStats } from "./records.ts";
export { type CreateLobbyResult, createLobby, type ReduceResult, type Rejection, reduce } from "./reducer.ts";
export {
  findShownQuestion,
  finishedGame,
  playedFinishedGame,
  type ReviewContext,
  reviewQuestionIds,
  toReviewItems,
} from "./review.ts";
export {
  assertRngRange,
  chance,
  createSeededRng,
  pickOne,
  RANDOM_ID_ALPHABET,
  RNG_MAX_RANGE,
  type Rng,
  randomId,
  shuffle,
  uniqueRandomId,
  weightedIndex,
} from "./rng.ts";
export { buildBoard, computeScores } from "./scoring.ts";
export { type CategoryOffer, type CategoryOfferInput, offerCategories } from "./selection/category-offer.ts";
export {
  buildSeenQuestions,
  indexPool,
  type PoolQuestion,
  type QuestionPool,
  type SeenQuestions,
} from "./selection/pool.ts";
export { type DrawnQuestion, drawQuestions, type QuestionDrawInput } from "./selection/question-draw.ts";
export {
  fromLobbySnapshot,
  GAME_SNAPSHOT_MIN_VERSION,
  GAME_SNAPSHOT_VERSION,
  type RestoreContext,
  type RestoreReset,
  type RestoreResult,
  toLobbySnapshot,
} from "./snapshot.ts";
export {
  activePlayers,
  connectedHumans,
  currentQuestion,
  currentTurn,
  findPlayer,
  findPlayerByGuestId,
  humanMembers,
  members,
} from "./state.ts";
export { standingsAfterRound, summarizeTurn, type TurnSummary, type TurnSummaryEntry } from "./summary.ts";
export {
  CLOSE_REASONS,
  type CloseReason,
  type EnginePlayer,
  GAME_END_REASONS,
  type GameEndReason,
  type GameResults,
  type GameState,
  isRunningPhase,
  type LobbyState,
  type PendingRequest,
  type PendingTimer,
  type PickedBy,
  type QuestionOutcome,
  type QuestionResponse,
  type QuestionState,
  type RankingEntry,
  RUNNING_PHASES,
  type RunningPhase,
  type ShownAnswers,
  type ShownOrder,
  TIMER_KINDS,
  type TimerKind,
  type TurnState,
} from "./types.ts";
