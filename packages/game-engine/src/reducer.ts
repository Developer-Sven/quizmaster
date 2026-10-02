/**
 * `reduce(state, command, ctx) → { state, effects }` (docs/02 §Engine-Muster, ADR-003): reine Übergänge
 * ohne I/O. Ablauf je Command: Handler → Normalisierung (lifecycle.ts) → Abschluss. Der Abschluss leitet
 * aus dem Unterschied alter/neuer Zustand ab:
 * - `broadcast` + `rev + 1`, wenn sich der öffentliche Zustand geändert hat,
 * - `sendPrivate` je Person, deren privater Zustand sich geändert hat (bei Beitritt/Reconnect immer),
 * - `scheduleTimer`/`cancelTimer` aus den geplanten Timern.
 *
 * Abgelehnte Commands liefern den unveränderten Zustand, keine Effects und `error { code, message }`.
 * Veraltete Shell-Antworten (TIMEOUT, OPTIONS_READY, QUESTIONS_READY, LOAD_FAILED) werden still ignoriert.
 */
import { type ErrorCode, ProtocolError } from "@quizmaster/shared";
import { type Command, type CreateLobbyInput, isShellCommand } from "./commands.ts";
import { assertNow, createTx, type EngineContext, type Tx } from "./context.ts";
import { EFFECT_ORDER, type Effect } from "./effects.ts";
import { onAnswer, onLoadFailed, onOptionsReady, onPick, onQuestionsReady } from "./game-commands.ts";
import { normalize, onTimerFired } from "./lifecycle.ts";
import {
  createLobbyState,
  isTimingMode,
  onAddBot,
  onContinue,
  onDisconnect,
  onJoin,
  onKick,
  onLeave,
  onReconnect,
  onRematch,
  onRename,
  onStart,
  onTransferHost,
  onUpdateSettings,
} from "./lobby.ts";
import { toPrivateState, toPublicState } from "./projection.ts";
import { findTimerByToken, removeTimers } from "./timers.ts";
import type { LobbyState, PendingTimer } from "./types.ts";

/** Fachliche Ablehnung (wird zum Fehler-Ack; `message` nur für Logs). */
export interface Rejection {
  code: ErrorCode;
  message: string;
}

export type ReduceResult =
  | { ok: true; state: LobbyState; effects: Effect[] }
  | { ok: false; state: LobbyState; effects: Effect[]; error: Rejection };

export type CreateLobbyResult = { ok: true; state: LobbyState; effects: Effect[] } | { ok: false; error: Rejection };

/** Öffentlicher Zustand ohne `rev` als Vergleichsschlüssel (je Zustandsobjekt gecacht – Zustände sind unveränderlich). */
const publicKeys = new WeakMap<LobbyState, string>();

function publicKey(state: LobbyState): string {
  const cached = publicKeys.get(state);
  if (cached !== undefined) return cached;
  const key = JSON.stringify({ ...toPublicState(state), rev: 0 });
  publicKeys.set(state, key);
  return key;
}

function privateKey(state: LobbyState, playerId: string): string | undefined {
  if (!state.players.some((player) => player.playerId === playerId)) return undefined;
  return JSON.stringify(toPrivateState(state, playerId));
}

function unchanged(state: LobbyState): ReduceResult {
  return { ok: true, state, effects: [] };
}

function rejected(state: LobbyState, code: ErrorCode, message: string): ReduceResult {
  return { ok: false, state, effects: [], error: { code, message } };
}

function sortEffects(effects: Effect[]): Effect[] {
  return effects
    .map((effect, index) => ({ effect, index }))
    .sort((a, b) => EFFECT_ORDER.indexOf(a.effect.type) - EFFECT_ORDER.indexOf(b.effect.type) || a.index - b.index)
    .map((entry) => entry.effect);
}

/** Leitet Broadcast, private Updates und Timer-Effects ab und setzt `rev`/`updatedAt`. */
function finalize(prev: LobbyState | null, next: LobbyState, tx: Tx, firedToken: number | null): ReduceResult {
  if (prev !== null && next === prev && tx.effects.length === 0 && tx.syncPlayerId === null) {
    return unchanged(prev);
  }
  const effects: Effect[] = [...tx.effects];
  const prevTimers = prev?.timers ?? [];
  const nextTokens = new Set(next.timers.map((timer) => timer.token));
  const prevTokens = new Set(prevTimers.map((timer) => timer.token));
  for (const timer of prevTimers) {
    if (!nextTokens.has(timer.token) && timer.token !== firedToken)
      effects.push({ type: "cancelTimer", token: timer.token });
  }
  for (const timer of next.timers) {
    if (!prevTokens.has(timer.token)) {
      effects.push({
        type: "scheduleTimer",
        at: timer.at,
        token: timer.token,
        kind: timer.kind,
        playerId: timer.playerId,
      });
    }
  }

  let state = next;
  const publicChanged = prev === null || publicKey(next) !== publicKey(prev);
  if (publicChanged) state = { ...state, rev: (prev?.rev ?? next.rev) + 1 };
  if (state !== prev) state = { ...state, updatedAt: tx.now };
  if (prev === null || state !== prev) publicKeys.set(state, publicKey(next));

  if (state.closed === null) {
    if (publicChanged || tx.syncPlayerId !== null) effects.push({ type: "broadcast" });
    for (const player of state.players) {
      if (player.isBot || player.left) continue;
      const forced = player.playerId === tx.syncPlayerId;
      if (forced || prev === null || privateKey(prev, player.playerId) !== privateKey(state, player.playerId)) {
        effects.push({ type: "sendPrivate", playerId: player.playerId, guestId: player.guestId });
      }
    }
  }
  if (tx.persistReason !== null) effects.push({ type: "persist", reason: tx.persistReason });
  return { ok: true, state, effects: sortEffects(effects) };
}

function dispatch(state: LobbyState, command: Command, tx: Tx, timer: PendingTimer | undefined): LobbyState {
  switch (command.type) {
    case "JOIN":
      return onJoin(state, command, tx);
    case "RECONNECT":
      return onReconnect(state, command, tx);
    case "DISCONNECT":
      return onDisconnect(state, command, tx);
    case "LEAVE":
      return onLeave(state, command, tx);
    case "UPDATE_SETTINGS":
      return onUpdateSettings(state, command, tx);
    case "RENAME":
      return onRename(state, command, tx);
    case "CONTINUE":
      return onContinue(state, command, tx);
    case "TRANSFER_HOST":
      return onTransferHost(state, command, tx);
    case "KICK":
      return onKick(state, command, tx);
    case "START":
      return onStart(state, command, tx);
    case "REMATCH":
      return onRematch(state, command, tx);
    case "ADD_BOT":
      return onAddBot(state, command, tx);
    case "PICK":
      return onPick(state, command, tx);
    case "ANSWER":
      return onAnswer(state, command, tx);
    case "OPTIONS_READY":
      return onOptionsReady(state, command, tx);
    case "QUESTIONS_READY":
      return onQuestionsReady(state, command, tx);
    case "LOAD_FAILED":
      return onLoadFailed(state, command, tx);
    case "TIMEOUT": {
      if (timer === undefined) return state;
      const token = timer.token;
      return onTimerFired(
        removeTimers(state, (entry) => entry.token === token),
        timer,
        tx,
      );
    }
  }
}

/**
 * Wendet einen Command an. Rein: der Eingabezustand wird nie verändert; Zeit nur aus `ctx.now`, Zufall
 * nur aus `ctx.rng`. Pro Lobby müssen Commands strikt nacheinander verarbeitet werden (LobbyActor).
 */
export function reduce(state: LobbyState, command: Command, ctx: EngineContext): ReduceResult {
  assertNow(ctx.now);
  const timer = command.type === "TIMEOUT" ? findTimerByToken(state, command.token) : undefined;
  if (command.type === "TIMEOUT" && timer === undefined) return unchanged(state);
  if (state.closed !== null) {
    return isShellCommand(command) || command.type === "DISCONNECT"
      ? unchanged(state)
      : rejected(state, "LOBBY_NOT_FOUND", "Lobby ist geschlossen");
  }
  // Ein Timer feuert nie „zu früh“: die Zeit gilt mindestens als seine Fälligkeit.
  const now = timer ? Math.max(ctx.now, timer.at) : ctx.now;
  const tx = createTx(state.timing, now, ctx.rng);
  let next: LobbyState;
  try {
    next = dispatch(state, command, tx, timer);
    if (!isShellCommand(command) && next !== state) next = { ...next, lastActivityAt: tx.now };
    next = normalize(next, tx);
  } catch (error) {
    if (error instanceof ProtocolError) return rejected(state, error.code, error.message);
    throw error;
  }
  return finalize(state, next, tx, timer?.token ?? null);
}

/** Erstellt eine Lobby (`lobby:create`) mit dem Host als erster Person. */
export function createLobby(input: CreateLobbyInput, ctx: EngineContext): CreateLobbyResult {
  assertNow(ctx.now);
  if (!isTimingMode(input.timing)) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "Ungültiger Timing-Modus" } };
  }
  const tx = createTx(input.timing, ctx.now, ctx.rng);
  let state: LobbyState;
  try {
    state = normalize(createLobbyState(input, tx), tx);
  } catch (error) {
    if (error instanceof ProtocolError) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
  const result = finalize(null, state, tx, null);
  return { ok: true, state: result.state, effects: result.effects };
}
