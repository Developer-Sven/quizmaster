/**
 * Invarianten nach jedem Command (Normalisierung) und Nicht-Phasen-Timer (docs/01 §Lobby,
 * §Verbindung & Randfälle; docs/05 §Timings):
 * - keine menschlichen Mitglieder mehr → Lobby schließen,
 * - weniger als 2 Aktive im laufenden Spiel → `game_over`,
 * - frühe Auflösung, sobald alle verbundenen aktiven Personen geantwortet haben (Bots zählen, Getrennte nicht),
 * - Host-Übergabe (Host weg: sofort; Host 30 s getrennt: an die am längsten anwesende verbundene Person),
 * - Fristen als Timer: Reconnect (Lobby 30 s / Spiel 90 s), Host-Übergabe, „niemand verbunden“ (60 s),
 *   „30 min ohne Aktivität“ (Lobby) bzw. „2 h nach Spielende“ (game_over), Antwort der Shell auf eine
 *   Anfrage (`SHELL_REQUEST_TIMEOUT_MS`, nur solange die Anfrage offen ist).
 */
import { GAME_RULES, LOBBY_LIFETIME } from "@quizmaster/shared";
import { requestPersist, type Tx } from "./context.ts";
import { finishGame, onPhaseTimeout, onRequestTimeout } from "./flow.ts";
import { removeFromLobby } from "./lobby.ts";
import { reschedulePhaseEnd } from "./phases.ts";
import {
  activePlayers,
  connectedHumans,
  currentQuestion,
  currentTurn,
  findPlayer,
  humanMembers,
  members,
} from "./state.ts";
import { addTimer, findTimer, removeTimers, syncTimer } from "./timers.ts";
import { type CloseReason, type EnginePlayer, isRunningPhase, type LobbyState, type PendingTimer } from "./types.ts";

/** Schließt die Lobby: Timer weg, offene Anfragen verworfen; Verbundene bekommen `kicked { inactive }`. */
export function closeLobby(state: LobbyState, reason: CloseReason, tx: Tx): LobbyState {
  if (reason !== "empty") {
    for (const player of connectedHumans(state)) {
      tx.effects.push({ type: "kick", playerId: player.playerId, guestId: player.guestId, reason: "inactive" });
    }
  }
  tx.effects.push({ type: "closeLobby", reason });
  requestPersist(tx, "closed");
  return {
    ...state,
    closed: { at: tx.now, reason },
    timers: [],
    game: state.game ? { ...state.game, pending: null } : null,
  };
}

/** Reconnect-Frist abgelaufen: in der Lobby entfernt, im Spiel „Aufgegeben“, nach dem Spiel ausgetreten. */
function onReconnectExpired(state: LobbyState, playerId: string | null, tx: Tx): LobbyState {
  const player = playerId === null ? undefined : findPlayer(state, playerId);
  if (!player || player.left || player.connected || player.isBot) return state;
  return removeFromLobby(state, player.playerId, tx);
}

/** Ein fälliger Timer (bereits aus dem Zustand entfernt). */
export function onTimerFired(state: LobbyState, timer: PendingTimer, tx: Tx): LobbyState {
  switch (timer.kind) {
    case "phase":
      return onPhaseTimeout(state, tx);
    case "reconnect":
      return onReconnectExpired(state, timer.playerId, tx);
    case "host_handover":
      // Die Übergabe selbst erledigt `ensureHost` (Normalisierung) mit der Zeit des Timers.
      return state;
    case "empty_close":
      return connectedHumans(state).length === 0 ? closeLobby(state, "empty", tx) : state;
    case "idle_close":
      return closeLobby(state, state.phase === "game_over" ? "after_game" : "idle", tx);
    case "request":
      return onRequestTimeout(state, tx);
  }
}

/** Frühe Auflösung (+400 ms), sobald alle verbundenen aktiven Teilnehmer:innen geantwortet haben. */
function ensureEarlyReveal(state: LobbyState, tx: Tx): LobbyState {
  if (state.phase !== "question") return state;
  const turn = currentTurn(state.game);
  const question = currentQuestion(state.game);
  if (!turn || !question || question.deadline === null) return state;
  const answered = new Set(question.responses.map((entry) => entry.playerId));
  const waitingFor = activePlayers(state).filter(
    (player) => player.connected && turn.participantIds.includes(player.playerId),
  );
  if (waitingFor.length === 0 || waitingFor.some((player) => !answered.has(player.playerId))) return state;
  const revealAt = Math.min(tx.now + tx.timings.earlyRevealMs, question.deadline + tx.timings.deadlineGraceMs);
  const timer = findTimer(state, "phase");
  if (timer !== undefined && timer.at <= revealAt) return state;
  return reschedulePhaseEnd(state, revealAt);
}

/** Menschliche Mitglieder, am längsten anwesend zuerst (ohne `excludeId`). */
function hostCandidates(state: LobbyState, excludeId: string | null): EnginePlayer[] {
  return humanMembers(state)
    .filter((player) => player.playerId !== excludeId)
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

function handOver(state: LobbyState, candidate: EnginePlayer, tx: Tx): LobbyState {
  tx.effects.push({ type: "notice", code: "HOST_CHANGED" });
  requestPersist(tx, "host");
  return { ...state, hostPlayerId: candidate.playerId };
}

/**
 * Host gültig halten: Ist der Host kein Mitglied mehr, übernimmt sofort die am längsten anwesende
 * verbundene Person (sonst die am längsten anwesende). Ist der Host seit ≥ 30 s getrennt, übernimmt die am
 * längsten anwesende verbundene Person – falls es eine gibt. Bots werden nie Host.
 */
function ensureHost(state: LobbyState, tx: Tx): LobbyState {
  const host = findPlayer(state, state.hostPlayerId);
  if (!host || host.left || host.isBot) {
    const candidates = hostCandidates(state, host?.playerId ?? null);
    const candidate = candidates.find((player) => player.connected) ?? candidates[0];
    return candidate ? handOver(state, candidate, tx) : state;
  }
  if (!host.connected && host.disconnectedAt !== null && tx.now >= host.disconnectedAt + tx.timings.hostHandoverMs) {
    const candidate = hostCandidates(state, host.playerId).find((player) => player.connected);
    if (candidate) return handOver(state, candidate, tx);
  }
  return state;
}

function syncHostTimer(state: LobbyState, tx: Tx): LobbyState {
  const host = findPlayer(state, state.hostPlayerId);
  let desiredAt: number | null = null;
  if (host && !host.left && !host.connected && host.disconnectedAt !== null) {
    const at = host.disconnectedAt + tx.timings.hostHandoverMs;
    // Bereits fällig ohne verbundene Kandidat:in: keine Endlosschleife – nächster Command prüft erneut.
    if (at > tx.now) desiredAt = at;
  }
  const cleared = removeTimers(
    state,
    (timer) => timer.kind === "host_handover" && timer.playerId !== state.hostPlayerId,
  );
  return syncTimer(cleared, "host_handover", state.hostPlayerId, desiredAt);
}

function syncReconnectTimers(state: LobbyState, tx: Tx): LobbyState {
  const grace = state.phase === "lobby" ? tx.timings.reconnectLobbyMs : tx.timings.reconnectGameMs;
  const desired = new Map<string, number>();
  for (const player of state.players) {
    if (!player.isBot && !player.left && !player.connected && player.disconnectedAt !== null) {
      desired.set(player.playerId, player.disconnectedAt + grace);
    }
  }
  let next = removeTimers(
    state,
    (timer) => timer.kind === "reconnect" && (timer.playerId === null || !desired.has(timer.playerId)),
  );
  for (const [playerId, at] of desired) next = syncTimer(next, "reconnect", playerId, at);
  return next;
}

function syncEmptyTimer(state: LobbyState, tx: Tx): LobbyState {
  const existing = findTimer(state, "empty_close");
  if (connectedHumans(state).length > 0) {
    return existing ? removeTimers(state, (timer) => timer.token === existing.token) : state;
  }
  return existing ? state : addTimer(state, "empty_close", tx.now + tx.timings.emptyLobbyCloseMs);
}

/** Die Frist einer Shell-Anfrage gilt nur, solange die Anfrage offen ist (beantwortet → Timer weg). */
function syncRequestTimer(state: LobbyState): LobbyState {
  if (state.game?.pending) return state;
  return removeTimers(state, (timer) => timer.kind === "request");
}

function syncIdleTimer(state: LobbyState): LobbyState {
  const endedAt = state.game?.endedAt ?? null;
  let desiredAt: number | null = null;
  if (state.phase === "lobby") desiredAt = state.lastActivityAt + LOBBY_LIFETIME.idleCloseMs;
  else if (state.phase === "game_over" && endedAt !== null) desiredAt = endedAt + LOBBY_LIFETIME.afterGameCloseMs;
  return syncTimer(state, "idle_close", null, desiredAt);
}

/**
 * Vorschläge (ADR-053) gibt es nur in der Lobby, solange sie erlaubt sind, und nur von Mitgliedern außer dem Host:
 * Spielstart, Abschalten, Gehen und Host-Wechsel räumen sie auf.
 */
function pruneSuggestions(state: LobbyState): LobbyState {
  if (state.suggestions.length === 0) return state;
  const memberIds = new Set(members(state).map((player) => player.playerId));
  const kept =
    state.phase === "lobby" && state.settings.allowSuggestions
      ? state.suggestions.filter((entry) => entry.playerId !== state.hostPlayerId && memberIds.has(entry.playerId))
      : [];
  return kept.length === state.suggestions.length ? state : { ...state, suggestions: kept };
}

/** Stellt nach jedem Command die Invarianten her (siehe Moduldoku). */
export function normalize(state: LobbyState, tx: Tx): LobbyState {
  if (state.closed !== null) return state;
  if (humanMembers(state).length === 0) return closeLobby(state, "empty", tx);
  let next = state;
  if (isRunningPhase(next.phase) && activePlayers(next).length < GAME_RULES.minPlayers) {
    next = finishGame(next, "not_enough_players", tx);
  }
  next = ensureEarlyReveal(next, tx);
  next = ensureHost(next, tx);
  next = pruneSuggestions(next);
  // Eingefroren gibt es nur im laufenden Spiel (ADR-057) – Spielende oder Lobby hebt es auf.
  if (next.frozen !== null && !isRunningPhase(next.phase)) next = { ...next, frozen: null };
  next = syncReconnectTimers(next, tx);
  next = syncHostTimer(next, tx);
  next = syncEmptyTimer(next, tx);
  next = syncRequestTimer(next);
  return syncIdleTimer(next);
}
