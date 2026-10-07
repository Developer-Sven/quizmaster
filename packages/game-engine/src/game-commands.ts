/**
 * Spiel-Commands (docs/05 §Client → Server, §Fairness & Anti-Cheat): Kategoriewahl, Antworten und die
 * Antworten der Shell auf `offerCategories`/`loadQuestions`.
 *
 * Antwort nur akzeptiert, wenn: Phase `question`, `questionId` = aktuelle Frage, Person aktiv, noch keine
 * Antwort, `startsAt ≤ now ≤ deadline + 250 ms` (Kulanz aus `Timings`). Das Ergebnis verrät nichts über
 * richtig/falsch (docs/06 Invariante 3) – die Engine liefert nur „angenommen“ oder einen Fehlercode.
 */
import {
  answerIndexSchema,
  type CategoryOption,
  categoryIdSchema,
  categoryOptionSchema,
  GAME_RULES,
  questionInstanceIdSchema,
} from "@quizmaster/shared";
import { arrangeAnswers } from "./answers.ts";
import {
  type AnswerCommand,
  type LoadFailedCommand,
  type OptionsReadyCommand,
  type PickCommand,
  type QuestionsReadyCommand,
  questionInputSchema,
} from "./commands.ts";
import { reject, type Tx } from "./context.ts";
import { advanceFrom, applyPick, finishGame, presentQuestion } from "./flow.ts";
import { requireMember } from "./lobby.ts";
import { enterPhase } from "./phases.ts";
import { uniqueRandomId } from "./rng.ts";
import {
  activePlayers,
  allQuestions,
  currentQuestion,
  currentTurn,
  requireGame,
  updateCurrentQuestion,
  updateCurrentTurn,
  updateGame,
  usedQuestionIds,
} from "./state.ts";
import type { LobbyState, QuestionState, TurnState } from "./types.ts";

/** Länge der Instanz-IDs von Fragen. */
const INSTANCE_ID_LENGTH = 12;

export function onPick(state: LobbyState, command: PickCommand, tx: Tx): LobbyState {
  const player = requireMember(state, command.guestId);
  if (state.phase !== "category_pick") reject("INVALID_PHASE", "Keine Kategoriewahl");
  const turn = currentTurn(state.game);
  if (!turn || turn.categoryId !== null) return reject("INVALID_PHASE", "Kategorie ist bereits gewählt");
  if (player.status !== "active") reject("RESIGNED", "Person hat aufgegeben");
  if (turn.pickerId !== player.playerId) reject("NOT_YOUR_TURN", "Andere Person wählt");
  if (!categoryIdSchema.safeParse(command.categoryId).success) reject("VALIDATION_FAILED", "Ungültige Kategorie");
  if (!turn.options.some((option) => option.id === command.categoryId)) {
    reject("INVALID_OPTION", "Kategorie gehört nicht zu den drei Optionen");
  }
  return applyPick(state, command.categoryId, "player", tx);
}

export function onAnswer(state: LobbyState, command: AnswerCommand, tx: Tx): LobbyState {
  const player = requireMember(state, command.guestId);
  if (
    !questionInstanceIdSchema.safeParse(command.questionId).success ||
    !answerIndexSchema.safeParse(command.choice).success
  ) {
    reject("VALIDATION_FAILED", "Ungültige Antwort");
  }
  const question = state.phase === "question" ? currentQuestion(state.game) : undefined;
  if (!question || question.instanceId !== command.questionId) {
    const shownBefore =
      state.game !== null &&
      allQuestions(state.game).some((entry) => entry.instanceId === command.questionId && entry.startsAt !== null);
    if (shownBefore) reject("TOO_LATE", "Frage ist bereits aufgelöst");
    return reject(state.phase === "question" ? "INVALID_OPTION" : "INVALID_PHASE", "Keine passende offene Frage");
  }
  // Anzeigender Host (ADR-046) spielt nicht mit: wie jemand, der an diesem Zug nicht teilnimmt.
  if (player.status === "spectator") reject("INVALID_PHASE", "Host zeigt nur an");
  if (player.status !== "active") reject("RESIGNED", "Person hat aufgegeben");
  const turn = currentTurn(state.game);
  if (!turn?.participantIds.includes(player.playerId)) reject("INVALID_PHASE", "Person nimmt an diesem Zug nicht teil");
  if (question.responses.some((entry) => entry.playerId === player.playerId)) {
    reject("ALREADY_ANSWERED", "Bereits geantwortet");
  }
  if (question.startsAt === null || tx.now < question.startsAt) reject("TOO_EARLY", "Frage hat noch nicht begonnen");
  if (question.deadline === null || tx.now > question.deadline + tx.timings.deadlineGraceMs) {
    reject("TOO_LATE", "Antwortzeit abgelaufen");
  }
  return updateCurrentQuestion(state, (current) => ({
    ...current,
    responses: [...current.responses, { playerId: player.playerId, choice: command.choice, at: tx.now }],
  }));
}

/**
 * Prüft die Kategorien aus OPTIONS_READY und liefert Kopien: 3 Optionen (`GAME_RULES.categoryOptionsPerTurn`) –
 * bei einer Auswahl des Hosts auch 1–2 (ADR-048) –, immer verschieden und gültig.
 */
function parseOptions(options: readonly CategoryOption[]): CategoryOption[] {
  const max = GAME_RULES.categoryOptionsPerTurn;
  if (!Array.isArray(options) || options.length < 1 || options.length > max) {
    reject("VALIDATION_FAILED", `1–${max} Kategorien erwartet`);
  }
  const parsed = options.map((option) => {
    const result = categoryOptionSchema.safeParse(option);
    if (!result.success) return reject("VALIDATION_FAILED", "Ungültige Kategorie-Option");
    return result.data;
  });
  if (new Set(parsed.map((option) => option.id)).size !== parsed.length)
    reject("VALIDATION_FAILED", "Kategorien doppelt");
  return parsed;
}

export function onOptionsReady(state: LobbyState, command: OptionsReadyCommand, tx: Tx): LobbyState {
  const pending = state.game?.pending;
  if (pending?.kind !== "options" || pending.token !== command.token) return state;
  const options = parseOptions(command.options);
  const activeIds = new Set(activePlayers(state).map((player) => player.playerId));
  if (!activeIds.has(pending.pickerId)) return advanceFrom(state, pending.round, pending.orderIndex, tx);
  const game = requireGame(state);
  const turn: TurnState = {
    number: game.turns.length + 1,
    round: pending.round,
    pickerId: pending.pickerId,
    options,
    categoryId: null,
    pickedBy: null,
    participantIds: game.order.filter((playerId) => activeIds.has(playerId)),
    questions: [],
    currentIndex: -1,
  };
  const next = updateGame(state, (current) => ({
    ...current,
    round: pending.round,
    orderIndex: pending.orderIndex,
    pending: null,
    turns: [...current.turns, turn],
  }));
  // Nur eine Kategorie erlaubt (ADR-048): keine Wahl, gleich die Fragen laden.
  const [only] = options;
  if (options.length === 1 && only !== undefined) return applyPick(next, only.id, "fixed", tx);
  return enterPhase(next, "category_pick", tx, { endsAt: tx.now + tx.timings.categoryPickMs });
}

/** Baut die Frage-Instanzen aus QUESTIONS_READY (validiert, gemischt, Instanz-IDs, Schwierigkeit aufsteigend). */
function buildQuestions(
  state: LobbyState,
  command: QuestionsReadyCommand,
  categoryId: string,
  tx: Tx,
): QuestionState[] {
  const game = requireGame(state);
  const inputs = command.questions;
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > state.settings.questionsPerCategory) {
    reject("VALIDATION_FAILED", `1–${state.settings.questionsPerCategory} Fragen erwartet`);
  }
  const used = new Set(usedQuestionIds(game));
  const takenInstanceIds = new Set(allQuestions(game).map((question) => question.instanceId));
  const questions = inputs.map((raw): QuestionState => {
    const parsed = questionInputSchema.safeParse(raw);
    if (!parsed.success) return reject("VALIDATION_FAILED", "Ungültige Frage");
    const input = parsed.data;
    if (input.category !== categoryId) reject("VALIDATION_FAILED", `Frage ${input._id} gehört nicht zu ${categoryId}`);
    if (used.has(input._id)) reject("VALIDATION_FAILED", `Frage ${input._id} kommt im Spiel doppelt vor`);
    if (new Set(input.answers).size !== input.answers.length) {
      reject("VALIDATION_FAILED", `Frage ${input._id} hat doppelte Antworten`);
    }
    used.add(input._id);
    const arranged = arrangeAnswers(input.answers, input.displayOrder, tx.rng);
    const instanceId = uniqueRandomId(tx.rng, takenInstanceIds, INSTANCE_ID_LENGTH);
    takenInstanceIds.add(instanceId);
    return {
      instanceId,
      questionId: input._id,
      categoryId: input.category,
      difficulty: input.difficulty,
      prompt: input.prompt,
      answers: arranged.answers,
      shownOrder: arranged.shownOrder,
      correct: arranged.correct,
      explanation: input.explanation,
      media: input.media ? { kind: input.media.kind, code: input.media.code } : null,
      startsAt: null,
      deadline: null,
      responses: [],
      outcomes: null,
    };
  });
  // „Pro Frage, zufällig“ (ADR-055): die zufällige Reihenfolge der Shell bleibt.
  if (state.settings.difficultyBasis === "question" && state.settings.difficultyOrder === "random") return questions;
  // Sonst innerhalb des Zuges leicht → schwer (stabil: gleiche Stufe behält die Reihenfolge der Shell).
  return questions.sort((a, b) => a.difficulty - b.difficulty);
}

export function onQuestionsReady(state: LobbyState, command: QuestionsReadyCommand, tx: Tx): LobbyState {
  const pending = state.game?.pending;
  if (pending?.kind !== "questions" || pending.token !== command.token) return state;
  const questions = buildQuestions(state, command, pending.categoryId, tx);
  const next = updateCurrentTurn(
    updateGame(state, (game) => ({ ...game, pending: null })),
    (turn) => ({ ...turn, questions, currentIndex: -1 }),
  );
  return presentQuestion(next, 0, tx);
}

export function onLoadFailed(state: LobbyState, command: LoadFailedCommand, tx: Tx): LobbyState {
  const pending = state.game?.pending;
  if (!pending || pending.token !== command.token) return state;
  return finishGame(state, "load_failed", tx);
}
