/**
 * Snapshot für die Collection `lobbies` (docs/04 §Schemas LobbyDoc; Effect `persist`) und Wiederaufnahme nach
 * einem Neustart (docs/07 Checkliste Phase 6, docs/12 §Deploy-Strategie). Enthält Server-Geheimnisse (guestIds,
 * richtige Antworten im Spiel-Snapshot) – nur in die Datenbank, nie an Clients.
 *
 * `game` ist der Engine-Spielzustand als JSON mit `snapshotVersion`:
 * - v1: GameState.
 * - v2: zusätzlich `leftPlayerIds` (Personen, die nicht mehr Mitglied sind – im Spiel aufgegeben, nach dem Spiel
 *   ausgetreten) und `lastActivityAt` (Basis von „30 min ohne Aktivität“). v1 bleibt lesbar.
 *
 * `fromLobbySnapshot` validiert ein Lobby-Dokument (zod + Konsistenz) und baut daraus einen Zustand für
 * `LobbyRegistry.adopt`:
 * - Alle Menschen gelten als getrennt (`disconnectedAt` = jetzt) – ihre Reconnect-Fristen beginnen neu, Bots sind
 *   verbunden. Clients kommen über `lobby:resume` (RECONNECT) zurück.
 * - Laufende Spielphasen beginnen neu (neue Zeitstempel und Timer): Frage → Anfang der aktuellen Frage (Antworten
 *   dieser Frage verfallen, Punkte aufgelöster Fragen bleiben), Kategoriewahl → Anfang der Kategoriewahl (eine
 *   schon getroffene Wahl, deren Fragen noch nicht geladen waren, verfällt), Intro/Auflösung/Zug-Ergebnis/
 *   Rundentafel → Phase von vorn; eine offene Anfrage an die Shell stellt der Phasen-Timer neu.
 * - `graceMs` verschiebt den Beginn von Frage und Kategoriewahl, damit alle wieder verbunden sein können.
 * - Lobby und Spielende bleiben, wie sie sind; Fristen (Reconnect, Host, leer, Leerlauf) plant `normalize` neu.
 */
import {
  answerIndexSchema,
  categoryIdSchema,
  categoryOptionSchema,
  DIFFICULTIES,
  GAME_TIMING_MODES,
  type GameTimingMode,
  gameResultsSchema,
  mediaSchema,
  type Phase,
  playerIdSchema,
  questionInstanceIdSchema,
  reviewItemSchema,
  shownAnswersSchema,
  timestampSchema,
} from "@quizmaster/shared";
import { QUESTION_ID_REGEX } from "@quizmaster/shared/content";
import {
  documentIdSchema,
  type GameSnapshot,
  type LobbyDoc,
  lobbyDocSchema,
  RETENTION,
  shownOrderSchema,
} from "@quizmaster/shared/documents";
import { z } from "zod";
import { createTx, type Tx } from "./context.ts";
import { presentQuestion } from "./flow.ts";
import { normalize } from "./lifecycle.ts";
import { advancePhaseEnd, enterPhase } from "./phases.ts";
import type { Rng } from "./rng.ts";
import { computeScores } from "./scoring.ts";
import { activePlayers, currentTurn, updateCurrentTurn, updateGame } from "./state.ts";
import {
  type EnginePlayer,
  GAME_END_REASONS,
  type GameState,
  isRunningPhase,
  type LobbyState,
  type QuestionState,
  type TurnState,
} from "./types.ts";

/** Version des Spiel-Snapshots in `lobbies.game` (erhöhen, wenn sich `GameState` inkompatibel ändert). */
export const GAME_SNAPSHOT_VERSION = 2;
/** Älteste lesbare Version. */
export const GAME_SNAPSHOT_MIN_VERSION = 1;

function expiresAt(state: LobbyState): number {
  if (state.closed !== null) return state.closed.at + RETENTION.endedLobbyMs;
  const endedAt = state.game?.endedAt ?? null;
  if (state.phase === "game_over" && endedAt !== null) return endedAt + RETENTION.endedLobbyMs;
  return state.updatedAt + RETENTION.activeLobbyMs;
}

/** LobbyDoc aus dem Zustand (ohne `owner`, das nur beim Scale-out gesetzt wird). */
export function toLobbySnapshot(state: LobbyState): LobbyDoc {
  const scores = computeScores(state.game);
  const game: GameSnapshot | null = state.game
    ? {
        snapshotVersion: GAME_SNAPSHOT_VERSION,
        ...structuredClone(state.game),
        leftPlayerIds: state.players.filter((player) => player.left).map((player) => player.playerId),
        lastActivityAt: state.lastActivityAt,
      }
    : null;
  return {
    _id: state.lobbyId,
    code: state.code,
    active: state.closed === null,
    phase: state.phase,
    rev: state.rev,
    settings: { ...state.settings },
    createdByGuestId: state.createdByGuestId,
    hostPlayerId: state.hostPlayerId,
    players: state.players.map((player) => ({
      playerId: player.playerId,
      guestId: player.guestId,
      name: player.name,
      color: player.color,
      isBot: player.isBot,
      joinedAt: new Date(player.joinedAt),
      status: player.status,
      score: scores.get(player.playerId) ?? 0,
    })),
    bannedGuestIds: [...state.bannedGuestIds],
    game,
    createdAt: new Date(state.createdAt),
    updatedAt: new Date(state.updatedAt),
    expiresAt: new Date(expiresAt(state)),
  };
}

// ── Validierung des Spiel-Snapshots ────────────────────────────────────────────────────────────────────

const questionIdSchema = z.string().regex(QUESTION_ID_REGEX);
const tokenSchema = z.int().min(0);

const responseSchema = z.strictObject({ playerId: playerIdSchema, choice: answerIndexSchema, at: timestampSchema });
const outcomeSchema = z.strictObject({
  playerId: playerIdSchema,
  choice: answerIndexSchema.nullable(),
  correct: z.boolean(),
  ms: z.int().min(0).nullable(),
});

const questionSchema = z.strictObject({
  instanceId: questionInstanceIdSchema,
  questionId: questionIdSchema,
  categoryId: categoryIdSchema,
  difficulty: z.literal(DIFFICULTIES),
  prompt: reviewItemSchema.shape.prompt,
  answers: shownAnswersSchema,
  shownOrder: shownOrderSchema,
  correct: answerIndexSchema,
  explanation: reviewItemSchema.shape.explanation,
  media: mediaSchema,
  startsAt: timestampSchema.nullable(),
  deadline: timestampSchema.nullable(),
  responses: z.array(responseSchema).max(8),
  outcomes: z.array(outcomeSchema).max(8).nullable(),
});

const turnSchema = z.strictObject({
  number: z.int().min(1),
  round: z.int().min(1),
  pickerId: playerIdSchema,
  options: z.array(categoryOptionSchema).min(1).max(3),
  categoryId: categoryIdSchema.nullable(),
  pickedBy: z.enum(["player", "timeout", "fixed"]).nullable(),
  participantIds: z.array(playerIdSchema).max(8),
  questions: z.array(questionSchema).max(10),
  currentIndex: z.int().min(-1),
});

const pendingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("options"),
    token: tokenSchema,
    pickerId: playerIdSchema,
    round: z.int().min(1),
    orderIndex: z.int().min(0),
  }),
  z.strictObject({ kind: z.literal("questions"), token: tokenSchema, categoryId: categoryIdSchema }),
]);

const gameSnapshotSchema = z.strictObject({
  snapshotVersion: z.int().min(GAME_SNAPSHOT_MIN_VERSION).max(GAME_SNAPSHOT_VERSION),
  gameId: documentIdSchema,
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
  endReason: z.enum(GAME_END_REASONS).nullable(),
  order: z.array(playerIdSchema).min(1).max(8),
  round: z.int().min(1),
  orderIndex: z.int().min(-1),
  turns: z.array(turnSchema).max(80),
  pending: pendingSchema.nullable(),
  results: gameResultsSchema.nullable(),
  leftPlayerIds: z.array(playerIdSchema).max(8).optional(),
  lastActivityAt: timestampSchema.optional(),
});

type ParsedGameSnapshot = z.output<typeof gameSnapshotSchema>;

// ── Wiederaufnahme ─────────────────────────────────────────────────────────────────────────────────────

export interface RestoreContext {
  /** Serverzeit der Wiederaufnahme (ms). */
  now: number;
  /** `GAME_TIMING` des Servers (steht nicht im Snapshot). */
  timing: GameTimingMode;
  /** Aufschub für den Beginn von Frage und Kategoriewahl (Zeit zum Wiederverbinden), Standard 0. */
  graceMs?: number;
}

/** Was beim Wiederaufnehmen zurückgesetzt wurde (für Logs). */
export type RestoreReset =
  | "none"
  | "phase_restarted"
  | "question_restarted"
  | "category_pick_restarted"
  | "pick_discarded";

export type RestoreResult = { ok: true; state: LobbyState; reset: RestoreReset } | { ok: false; reason: string };

/** Zufall braucht die Wiederaufnahme nicht – ein Aufruf wäre ein Programmierfehler. */
const NO_RANDOM: Rng = {
  int() {
    throw new Error("Die Wiederaufnahme verwendet keinen Zufall");
  },
};

class RestoreError extends Error {}

function fail(reason: string): never {
  throw new RestoreError(reason);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join(".") || "(dokument)"}: ${issue.code}`)
    .join("; ");
}

/** Prüft, dass der Spielzustand zu Personen und Phase passt (sonst wäre er nicht spielbar). */
function checkConsistency(doc: LobbyDoc, game: ParsedGameSnapshot): void {
  const playerIds = new Set(doc.players.map((player) => player.playerId));
  if (playerIds.size !== doc.players.length) fail("playerIds doppelt");
  if (!playerIds.has(doc.hostPlayerId)) fail("Host ist keine Person der Lobby");
  for (const id of game.order) if (!playerIds.has(id)) fail("Reihenfolge enthält unbekannte Person");
  if (new Set(game.order).size !== game.order.length) fail("Reihenfolge doppelt");
  for (const id of game.leftPlayerIds ?? []) if (!playerIds.has(id)) fail("leftPlayerIds enthält unbekannte Person");
  const instanceIds = new Set<string>();
  for (const [turnIndex, turn] of game.turns.entries()) {
    if (!playerIds.has(turn.pickerId)) fail(`Zug ${turnIndex + 1}: unbekannte wählende Person`);
    if (turn.categoryId !== null && !turn.options.some((option) => option.id === turn.categoryId)) {
      fail(`Zug ${turnIndex + 1}: Kategorie nicht unter den Optionen`);
    }
    if (turn.currentIndex >= turn.questions.length) fail(`Zug ${turnIndex + 1}: Frageindex außerhalb`);
    for (const question of turn.questions) {
      if (instanceIds.has(question.instanceId)) fail("Instanz-IDs doppelt");
      instanceIds.add(question.instanceId);
      // `correct` ist die Position der Repo-Antwort 0 (richtig) in der angezeigten Reihenfolge.
      if (question.shownOrder[question.correct] !== 0) fail("richtige Antwort passt nicht zur Mischung");
    }
  }
  const turn = game.turns.at(-1);
  const question = turn && turn.currentIndex >= 0 ? turn.questions[turn.currentIndex] : undefined;
  switch (doc.phase) {
    case "category_pick":
      if (turn === undefined) fail("Kategoriewahl ohne Zug");
      return;
    case "question":
      if (question === undefined) fail("Frage-Phase ohne gestellte Frage");
      if (question.outcomes !== null) fail("Frage-Phase mit bereits aufgelöster Frage");
      return;
    case "reveal":
      if (question?.outcomes == null) fail("Auflösung ohne aufgelöste Frage");
      return;
    case "game_over":
      if (game.results === null || game.endedAt === null) fail("Spielende ohne Ergebnis");
      return;
    default:
      return;
  }
}

function toGameState(game: ParsedGameSnapshot): GameState {
  const turns: TurnState[] = game.turns.map((turn) => ({
    ...turn,
    options: turn.options.map((option) => ({ ...option })),
    questions: turn.questions.map(
      (question): QuestionState => ({
        ...question,
        responses: question.responses.map((response) => ({ ...response })),
        outcomes: question.outcomes === null ? null : question.outcomes.map((outcome) => ({ ...outcome })),
      }),
    ),
  }));
  return {
    gameId: game.gameId,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
    endReason: game.endReason,
    order: [...game.order],
    round: game.round,
    orderIndex: game.orderIndex,
    turns,
    pending: game.pending === null ? null : { ...game.pending },
    results: game.results,
  };
}

/** Setzt eine laufende Phase auf ihren Anfang zurück (siehe Moduldoku). */
function restartPhase(state: LobbyState, from: Phase, tx: Tx, graceMs: number): [LobbyState, RestoreReset] {
  const timings = tx.timings;
  const now = tx.now;
  switch (from) {
    case "lobby":
      return [enterPhase(state, "lobby", tx, { endsAt: null }), "none"];
    case "game_over": {
      // Beginn der Phase = Spielende (sonst spielte der Client die Siegerehrung erneut ab).
      // Nach dem Neustart steht das Ergebnis noch einmal `gameOverMs`, dann geht es zurück in die Lobby (ADR-038).
      const over = enterPhase(state, "game_over", tx, { endsAt: now + timings.gameOverMs });
      return [{ ...over, phaseStartedAt: state.game?.endedAt ?? now }, "none"];
    }
    case "intro":
      return [enterPhase(clearPending(state), "intro", tx, { endsAt: now + timings.introMs }), "phase_restarted"];
    case "turn_summary":
      return [
        enterPhase(clearPending(state), "turn_summary", tx, {
          endsAt: advancePhaseEnd(state, "turn_summary", now, timings),
        }),
        "phase_restarted",
      ];
    case "round_board":
      return [
        enterPhase(clearPending(state), "round_board", tx, {
          endsAt: advancePhaseEnd(state, "round_board", now, timings),
        }),
        "phase_restarted",
      ];
    case "reveal":
      // „Host tippt Weiter“ (ADR-045): auch nach dem Neustart ohne Timer, der Host geht weiter.
      return [
        enterPhase(state, "reveal", tx, { endsAt: advancePhaseEnd(state, "reveal", now, timings) }),
        "phase_restarted",
      ];
    case "category_pick": {
      const turn = currentTurn(state.game);
      if (turn === undefined) return fail("Kategoriewahl ohne Zug");
      const discarded = turn.categoryId !== null;
      const reset = updateCurrentTurn(clearPending(state), (current) => ({
        ...current,
        categoryId: null,
        pickedBy: null,
      }));
      // Wählt eine Person, die nicht mehr aktiv ist, entscheidet sofort der Zufall (wie beim Aufgeben).
      const pickerActive = activePlayers(reset).some((player) => player.playerId === turn.pickerId);
      const endsAt = pickerActive ? now + graceMs + timings.categoryPickMs : now;
      return [
        enterPhase(reset, "category_pick", tx, { endsAt }),
        discarded ? "pick_discarded" : "category_pick_restarted",
      ];
    }
    case "question": {
      const turn = currentTurn(state.game);
      if (turn === undefined || turn.currentIndex < 0) return fail("Frage-Phase ohne gestellte Frage");
      const index = turn.currentIndex;
      const cleared = updateCurrentTurn(clearPending(state), (current) => ({
        ...current,
        questions: current.questions.map((question, position) =>
          position === index ? { ...question, responses: [], outcomes: null } : question,
        ),
      }));
      // Anfang der Frage: Vorlauf wie beim ersten Stellen (+ Aufschub), dann die volle Antwortzeit.
      const restarted = presentQuestion(cleared, index, { ...tx, now: now + graceMs });
      return [{ ...restarted, phaseStartedAt: now }, "question_restarted"];
    }
  }
}

function clearPending(state: LobbyState): LobbyState {
  if (state.game === null || state.game.pending === null) return state;
  return updateGame(state, (game) => ({ ...game, pending: null }));
}

/**
 * Baut aus einem Lobby-Dokument einen Zustand zur Wiederaufnahme (siehe Moduldoku) – oder nennt den Grund, warum
 * das nicht geht (ungültig, geschlossen, inkonsistent). Rein: keine I/O, Zeit aus `ctx.now`.
 */
export function fromLobbySnapshot(raw: unknown, ctx: RestoreContext): RestoreResult {
  try {
    if (!(GAME_TIMING_MODES as readonly string[]).includes(ctx.timing)) fail("Ungültiger Timing-Modus");
    const parsed = lobbyDocSchema.safeParse(raw);
    if (!parsed.success) return fail(`Lobby-Dokument ungültig (${describeIssues(parsed.error)})`);
    const doc = parsed.data;
    if (!doc.active) fail("Lobby ist geschlossen");
    if (doc.players.length === 0) fail("Lobby ohne Personen");

    let game: ParsedGameSnapshot | null = null;
    if (doc.game !== null) {
      const gameParsed = gameSnapshotSchema.safeParse(doc.game);
      if (!gameParsed.success) fail(`Spiel-Snapshot ungültig (${describeIssues(gameParsed.error)})`);
      game = gameParsed.data;
    }
    if (doc.phase !== "lobby" && game === null) fail(`Phase ${doc.phase} ohne Spiel-Snapshot`);
    if (game !== null) checkConsistency(doc, game);

    const now = ctx.now;
    const tx = createTx(ctx.timing, now, NO_RANDOM);
    const leftIds = new Set(
      game?.leftPlayerIds ??
        // v1: Wer im Spiel aufgegeben hat, ist kein Mitglied mehr (resignPlayer setzt beides).
        (doc.phase !== "lobby"
          ? doc.players.filter((player) => player.status === "resigned").map((p) => p.playerId)
          : []),
    );
    const players: EnginePlayer[] = doc.players.map((player) => {
      const left = doc.phase === "lobby" ? false : leftIds.has(player.playerId);
      const connected = player.isBot && !left;
      return {
        playerId: player.playerId,
        guestId: player.guestId,
        name: player.name,
        color: player.color,
        isBot: player.isBot,
        joinedAt: player.joinedAt.getTime(),
        connected,
        disconnectedAt: connected || left ? null : now,
        status: player.status,
        left,
      };
    });
    if (doc.phase === "lobby" && players.some((player) => player.status !== "active")) {
      fail("Lobby-Phase mit aufgegebener Person");
    }

    const base: LobbyState = {
      lobbyId: doc._id,
      code: doc.code,
      timing: ctx.timing,
      rev: doc.rev + 1,
      phase: doc.phase,
      phaseToken: 0,
      phaseStartedAt: now,
      phaseEndsAt: null,
      createdAt: doc.createdAt.getTime(),
      updatedAt: now,
      lastActivityAt: game?.lastActivityAt ?? doc.updatedAt.getTime(),
      createdByGuestId: doc.createdByGuestId,
      hostPlayerId: doc.hostPlayerId,
      settings: { ...doc.settings },
      players,
      bannedGuestIds: [...doc.bannedGuestIds],
      // Vorschläge (ADR-053) sind flüchtig: nach einem Neustart gibt es keine.
      suggestions: [],
      // Eingefroren (ADR-057) ebenso – laufende Phasen beginnen nach dem Neustart ohnehin neu.
      frozen: null,
      seq: 0,
      timers: [],
      game: game === null ? null : toGameState(game),
      closed: null,
    };
    if (base.game !== null && isRunningPhase(doc.phase) && base.game.endedAt !== null) {
      fail("Laufende Phase mit beendetem Spiel");
    }

    const [restarted, reset] = restartPhase(base, doc.phase, tx, Math.max(0, ctx.graceMs ?? 0));
    // Fristen (Reconnect, Host-Übergabe, „niemand verbunden“, Leerlauf) wie nach jedem Command.
    const normalized = normalize(restarted, tx);
    if (normalized.closed !== null) fail("Lobby ohne menschliche Mitglieder");
    if (normalized.phase !== restarted.phase) fail(`Phase ${restarted.phase} nicht fortsetzbar`);
    return { ok: true, state: normalized, reset };
  } catch (error) {
    if (error instanceof RestoreError) return { ok: false, reason: error.message };
    throw error;
  }
}
