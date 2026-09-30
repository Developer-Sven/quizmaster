/**
 * Lobby-Verwaltung (docs/01 §Lobby, docs/05 §Client → Server): Erstellen, Beitreten, Wiederverbinden,
 * Trennen, Verlassen, Einstellungen, Entfernen (+ Lobby-Sperre), Start, Revanche, Dev-Bots.
 * Ablehnungen werfen `ProtocolError` mit ErrorCode aus shared (siehe context.ts).
 */
import {
  applySettingsUpdate,
  DEFAULT_LOBBY_SETTINGS,
  GAME_RULES,
  GAME_TIMING_MODES,
  guestIdSchema,
  lobbyCodeSchema,
  makeUniqueName,
  nameKey,
  pickPlayerColor,
  playerIdSchema,
  updateSettingsPayloadSchema,
  validateNameFormat,
} from "@quizmaster/shared";
import type {
  AddBotCommand,
  CreateLobbyInput,
  DisconnectCommand,
  JoinCommand,
  KickCommand,
  LeaveCommand,
  ReconnectCommand,
  RematchCommand,
  StartCommand,
  UpdateSettingsCommand,
} from "./commands.ts";
import { reject, requestPersist, type Tx } from "./context.ts";
import { resignPlayer, startGame } from "./flow.ts";
import { randomId, uniqueRandomId } from "./rng.ts";
import {
  connectedMembers,
  findPlayer,
  findPlayerByGuestId,
  isBanned,
  members,
  removePlayer,
  updatePlayer,
} from "./state.ts";
import { type EnginePlayer, isRunningPhase, type LobbyState } from "./types.ts";

/** Länge öffentlicher playerIds und interner IDs. */
const ID_LENGTH = 16;

/**
 * Mitglied zur guestId oder Ablehnung: gesperrt → KICKED, aufgegeben → RESIGNED, sonst LOBBY_NOT_FOUND
 * (aus Sicht der Person gibt es „ihre“ Lobby nicht mehr).
 */
export function requireMember(state: LobbyState, guestId: string): EnginePlayer {
  const player = findPlayerByGuestId(state, guestId);
  if (player && !player.left) return player;
  if (isBanned(state, guestId)) reject("KICKED", "Person wurde aus der Lobby entfernt");
  if (player?.status === "resigned") reject("RESIGNED", "Person hat das Spiel verlassen");
  return reject("LOBBY_NOT_FOUND", "Kein Mitglied dieser Lobby");
}

export function requireHost(state: LobbyState, guestId: string): EnginePlayer {
  const player = requireMember(state, guestId);
  if (player.playerId !== state.hostPlayerId) reject("NOT_HOST", "Nur der Host darf das");
  return player;
}

function takenPlayerIds(state: LobbyState): Set<string> {
  return new Set(state.players.map((player) => player.playerId));
}

/** Neue Lobby mit dem Host als erster Person (Phase `lobby`, Standard-Einstellungen). */
export function createLobbyState(input: CreateLobbyInput, tx: Tx): LobbyState {
  if (!lobbyCodeSchema.safeParse(input.code).success) reject("VALIDATION_FAILED", "Ungültiger Lobby-Code");
  if (!guestIdSchema.safeParse(input.guestId).success) reject("VALIDATION_FAILED", "Ungültige guestId");
  const format = validateNameFormat(input.name);
  if (!format.ok) return reject("NAME_REJECTED", `Name: ${format.reason}`);
  const color = pickPlayerColor([]);
  if (color === null) throw new Error("Keine Spielerfarben definiert");
  const host: EnginePlayer = {
    playerId: randomId(tx.rng, ID_LENGTH),
    guestId: input.guestId,
    name: format.name,
    color,
    isBot: false,
    joinedAt: tx.now,
    connected: true,
    disconnectedAt: null,
    status: "active",
    left: false,
  };
  tx.syncPlayerId = host.playerId;
  requestPersist(tx, "created");
  return {
    lobbyId: randomId(tx.rng, ID_LENGTH),
    code: input.code,
    timing: input.timing,
    rev: 0,
    phase: "lobby",
    phaseToken: 0,
    phaseStartedAt: tx.now,
    phaseEndsAt: null,
    createdAt: tx.now,
    updatedAt: tx.now,
    lastActivityAt: tx.now,
    createdByGuestId: input.guestId,
    hostPlayerId: host.playerId,
    settings: { ...DEFAULT_LOBBY_SETTINGS },
    players: [host],
    bannedGuestIds: [],
    seq: 0,
    timers: [],
    game: null,
    closed: null,
  };
}

/** true, wenn `timing` ein gültiger Timing-Modus ist. */
export function isTimingMode(timing: unknown): timing is CreateLobbyInput["timing"] {
  return typeof timing === "string" && (GAME_TIMING_MODES as readonly string[]).includes(timing);
}

function reconnectPlayer(state: LobbyState, player: EnginePlayer, tx: Tx): LobbyState {
  tx.syncPlayerId = player.playerId;
  if (player.connected) return state;
  return updatePlayer(state, player.playerId, { connected: true, disconnectedAt: null });
}

export function onJoin(state: LobbyState, command: JoinCommand, tx: Tx): LobbyState {
  if (!guestIdSchema.safeParse(command.guestId).success) reject("VALIDATION_FAILED", "Ungültige guestId");
  if (isBanned(state, command.guestId)) reject("KICKED", "Person wurde aus der Lobby entfernt");
  const existing = findPlayerByGuestId(state, command.guestId);
  if (existing && !existing.left) return reconnectPlayer(state, existing, tx);
  if (state.phase !== "lobby") reject("GAME_IN_PROGRESS", "Das Spiel läuft bereits");
  if (members(state).length >= state.settings.maxPlayers) reject("LOBBY_FULL", "Lobby ist voll");
  const format = validateNameFormat(command.name);
  if (!format.ok) return reject("NAME_REJECTED", `Name: ${format.reason}`);
  const color = pickPlayerColor(state.players.map((player) => player.color));
  if (color === null) return reject("LOBBY_FULL", "Keine Farbe frei");
  const player: EnginePlayer = {
    playerId: uniqueRandomId(tx.rng, takenPlayerIds(state), ID_LENGTH),
    guestId: command.guestId,
    name: makeUniqueName(
      format.name,
      state.players.map((entry) => entry.name),
    ),
    color,
    isBot: false,
    joinedAt: tx.now,
    connected: true,
    disconnectedAt: null,
    status: "active",
    left: false,
  };
  tx.syncPlayerId = player.playerId;
  requestPersist(tx, "players");
  return { ...state, players: [...state.players, player] };
}

export function onReconnect(state: LobbyState, command: ReconnectCommand, tx: Tx): LobbyState {
  return reconnectPlayer(state, requireMember(state, command.guestId), tx);
}

/** Letzter Socket getrennt: Fristen beginnen (Planung in lifecycle.ts). Unbekannte Personen: nichts zu tun. */
export function onDisconnect(state: LobbyState, command: DisconnectCommand, tx: Tx): LobbyState {
  const player = findPlayerByGuestId(state, command.guestId);
  if (!player || player.left || player.isBot || !player.connected) return state;
  return updatePlayer(state, player.playerId, { connected: false, disconnectedAt: tx.now });
}

/**
 * Person verlässt die Lobby bzw. wird entfernt: in `lobby` gelöscht (Farbe wird frei), im Spiel
 * „Aufgegeben“, in `game_over` für das Ergebnis sichtbar und bei der Revanche entfernt.
 */
export function removeFromLobby(state: LobbyState, playerId: string, tx: Tx): LobbyState {
  requestPersist(tx, "players");
  if (state.phase === "lobby") return removePlayer(state, playerId);
  if (isRunningPhase(state.phase)) return resignPlayer(state, playerId, tx);
  return updatePlayer(state, playerId, { left: true, connected: false, disconnectedAt: null });
}

export function onLeave(state: LobbyState, command: LeaveCommand, tx: Tx): LobbyState {
  return removeFromLobby(state, requireMember(state, command.guestId).playerId, tx);
}

export function onUpdateSettings(state: LobbyState, command: UpdateSettingsCommand, tx: Tx): LobbyState {
  requireHost(state, command.guestId);
  if (state.phase !== "lobby") reject("INVALID_PHASE", "Einstellungen nur vor Spielbeginn");
  const parsed = updateSettingsPayloadSchema.safeParse(command.update);
  if (!parsed.success) return reject("VALIDATION_FAILED", "Ungültige Einstellungen");
  const settings = applySettingsUpdate(state.settings, parsed.data);
  if (settings.maxPlayers < members(state).length) {
    reject("INVALID_OPTION", "Personen maximal liegt unter der aktuellen Personenzahl");
  }
  requestPersist(tx, "settings");
  return { ...state, settings };
}

export function onKick(state: LobbyState, command: KickCommand, tx: Tx): LobbyState {
  const host = requireHost(state, command.guestId);
  const target = playerIdSchema.safeParse(command.targetPlayerId).success
    ? findPlayer(state, command.targetPlayerId)
    : undefined;
  if (!target || target.left) return reject("INVALID_OPTION", "Person ist nicht in der Lobby");
  if (target.playerId === host.playerId) reject("INVALID_OPTION", "Der Host kann sich nicht selbst entfernen");
  tx.effects.push({ type: "kick", playerId: target.playerId, guestId: target.guestId, reason: "host" });
  const bannedGuestIds = isBanned(state, target.guestId)
    ? state.bannedGuestIds
    : [...state.bannedGuestIds, target.guestId];
  return removeFromLobby({ ...state, bannedGuestIds }, target.playerId, tx);
}

export function onStart(state: LobbyState, command: StartCommand, tx: Tx): LobbyState {
  requireHost(state, command.guestId);
  if (state.phase !== "lobby") reject("INVALID_PHASE", "Start nur in der Lobby");
  if (connectedMembers(state).length < GAME_RULES.minPlayers) {
    reject("NOT_ENOUGH_PLAYERS", "Mindestens 2 verbundene Personen nötig");
  }
  return startGame(state, tx);
}

export function onRematch(state: LobbyState, command: RematchCommand, tx: Tx): LobbyState {
  requireHost(state, command.guestId);
  if (state.phase !== "game_over") reject("INVALID_PHASE", "Revanche nur nach Spielende");
  // Gleiche Personen: wer verlassen hat, aufgegeben hat oder entfernt wurde, ist nicht mehr dabei.
  const remaining = members(state);
  if (remaining.filter((player) => player.connected).length < GAME_RULES.minPlayers) {
    reject("NOT_ENOUGH_PLAYERS", "Mindestens 2 verbundene Personen nötig");
  }
  requestPersist(tx, "players");
  return startGame({ ...state, players: remaining }, tx);
}

/** „Bot 1“, „Bot 2“ … – erster freier Name (Groß/Klein egal). */
function nextBotName(state: LobbyState): string {
  const taken = new Set(state.players.map((player) => nameKey(player.name)));
  for (let number = 1; ; number++) {
    const name = `Bot ${number}`;
    if (!taken.has(nameKey(name))) return name;
  }
}

export function onAddBot(state: LobbyState, command: AddBotCommand, tx: Tx): LobbyState {
  requireHost(state, command.guestId);
  if (state.phase !== "lobby") reject("INVALID_PHASE", "Bots nur vor Spielbeginn");
  if (members(state).length >= state.settings.maxPlayers) reject("LOBBY_FULL", "Lobby ist voll");
  if (state.players.filter((player) => player.isBot).length >= GAME_RULES.maxBotsPerLobby) {
    reject("LOBBY_FULL", `Höchstens ${GAME_RULES.maxBotsPerLobby} Bots`);
  }
  const color = pickPlayerColor(state.players.map((player) => player.color));
  if (color === null) return reject("LOBBY_FULL", "Keine Farbe frei");
  const bot: EnginePlayer = {
    playerId: uniqueRandomId(tx.rng, takenPlayerIds(state), ID_LENGTH),
    guestId: `bot:${randomId(tx.rng, ID_LENGTH)}`,
    name: nextBotName(state),
    color,
    isBot: true,
    joinedAt: tx.now,
    connected: true,
    disconnectedAt: null,
    status: "active",
    left: false,
  };
  requestPersist(tx, "players");
  return { ...state, players: [...state.players, bot] };
}
