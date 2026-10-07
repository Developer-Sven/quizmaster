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
  type LobbySettings,
  lobbyCodeSchema,
  MANUAL_ADVANCE,
  makeUniqueName,
  nameKey,
  pickPlayerColor,
  playerIdSchema,
  SETTINGS_BOUNDS,
  type SettingsSuggestion,
  type SuggestionStatus,
  settingsChangesBetween,
  settingsChangesSchema,
  updateSettingsPayloadSchema,
  validateNameFormat,
} from "@quizmaster/shared";
import type {
  AcceptSuggestionCommand,
  AddBotCommand,
  ContinueCommand,
  CreateLobbyInput,
  DeclineSuggestionCommand,
  DisconnectCommand,
  EndGameCommand,
  JoinCommand,
  KickCommand,
  LeaveCommand,
  ReconnectCommand,
  RematchCommand,
  RenameCommand,
  StartCommand,
  SuggestSettingsCommand,
  TransferHostCommand,
  UpdateSettingsCommand,
  WithdrawSuggestionCommand,
} from "./commands.ts";
import { reject, requestPersist, type Tx } from "./context.ts";
import {
  finishGame,
  isSpectatingHost,
  onPhaseTimeout,
  resignPlayer,
  revealCurrentQuestion,
  startGame,
} from "./flow.ts";
import { randomId, uniqueRandomId } from "./rng.ts";
import {
  connectedMembers,
  currentQuestion,
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
    suggestions: [],
    frozen: null,
    reconnectHold: null,
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

/**
 * Fachliche Grenzen neuer Einstellungen: „Personen maximal“ nie unter der Personenzahl, Schwierigkeit „von“ ≤ „bis“
 * (ADR-055), der Reihe nach höchstens so viele Kategorien wie Runden möglich (ADR-056).
 */
function checkSettings(state: LobbyState, settings: LobbySettings): void {
  if (settings.maxPlayers < members(state).length) {
    reject("INVALID_OPTION", "Personen maximal liegt unter der aktuellen Personenzahl");
  }
  if (settings.difficultyMin > settings.difficultyMax) reject("INVALID_OPTION", "Schwierigkeit „von“ über „bis“");
  if (settings.categoryMode === "sequence" && (settings.categoryIds?.length ?? 0) > SETTINGS_BOUNDS.rounds.max) {
    reject("INVALID_OPTION", `Der Reihe nach höchstens ${SETTINGS_BOUNDS.rounds.max} Kategorien`);
  }
}

export function onUpdateSettings(state: LobbyState, command: UpdateSettingsCommand, tx: Tx): LobbyState {
  requireHost(state, command.guestId);
  if (state.phase !== "lobby") reject("INVALID_PHASE", "Einstellungen nur vor Spielbeginn");
  const parsed = updateSettingsPayloadSchema.safeParse(command.update);
  if (!parsed.success) return reject("VALIDATION_FAILED", "Ungültige Einstellungen");
  const settings = applySettingsUpdate(state.settings, parsed.data);
  checkSettings(state, settings);
  requestPersist(tx, "settings");
  return { ...state, settings };
}

/**
 * Eigenen Namen ändern (ADR-041): nur in der Lobby, Format wie beim Beitritt, eindeutig gegenüber den anderen
 * Personen (der eigene bisherige Name zählt nicht als belegt). Gleicher Name → keine Änderung.
 */
export function onRename(state: LobbyState, command: RenameCommand, tx: Tx): LobbyState {
  const player = requireMember(state, command.guestId);
  if (state.phase !== "lobby") reject("INVALID_PHASE", "Namen nur vor Spielbeginn ändern");
  const format = validateNameFormat(command.name);
  if (!format.ok) return reject("NAME_REJECTED", `Name: ${format.reason}`);
  const name = makeUniqueName(
    format.name,
    state.players.filter((entry) => entry.playerId !== player.playerId).map((entry) => entry.name),
  );
  if (name === player.name) return state;
  requestPersist(tx, "players");
  return updatePlayer(state, player.playerId, { name });
}

/**
 * „Weiter“ des Hosts (ADR-045): nur in der genannten Weiter-Phase und nur, wenn sie auf den Host wartet (kein
 * Phasenende). Danach geht es weiter wie nach einem abgelaufenen Timer.
 */
export function onContinue(state: LobbyState, command: ContinueCommand, tx: Tx): LobbyState {
  requireHost(state, command.guestId);
  if (state.game === null || state.phase !== command.phase) reject("INVALID_PHASE", "Diese Phase läuft nicht");
  // Eingefroren (ADR-057): erst weiter, wenn die Mitspielenden wieder zu hören sind.
  if (state.frozen !== null) reject("INVALID_PHASE", "Spiel ist angehalten");
  // Frage auflösen bei „Zeit pro Frage: Host“ (ADR-049) – erst, wenn die Frage zu sehen ist.
  if (command.phase === "question") {
    if (state.settings.answerSec !== MANUAL_ADVANCE) reject("INVALID_PHASE", "Die Frage hat einen Countdown");
    const question = currentQuestion(state.game);
    if (question?.startsAt == null || tx.now < question.startsAt) reject("TOO_EARLY", "Frage hat noch nicht begonnen");
    return revealCurrentQuestion(state, tx);
  }
  if (state.phaseEndsAt !== null) reject("INVALID_PHASE", "Diese Phase geht automatisch weiter");
  // Schon weitergeschaltet, die Shell lädt die nächste Kategorie (Doppeltipp): kein zweiter Schritt.
  if (state.game.pending !== null) reject("INVALID_PHASE", "Es geht schon weiter");
  return onPhaseTimeout(state, tx);
}

/**
 * Host beendet das laufende Spiel für alle (ADR-051): Ergebnis mit dem aktuellen Stand – eine offene, noch nicht
 * aufgelöste Frage zählt nicht –, Hinweis `GAME_ENDED`, danach wie gewohnt zurück in die Lobby.
 */
export function onEndGame(state: LobbyState, command: EndGameCommand, tx: Tx): LobbyState {
  requireHost(state, command.guestId);
  if (!isRunningPhase(state.phase) || state.game === null) reject("INVALID_PHASE", "Kein laufendes Spiel");
  tx.effects.push({ type: "notice", code: "GAME_ENDED" });
  return finishGame(state, "host_ended", tx);
}

/** Host gibt die Rolle an eine verbundene menschliche Person ab (ADR-047); alle erfahren es per Hinweis. */
export function onTransferHost(state: LobbyState, command: TransferHostCommand, tx: Tx): LobbyState {
  const host = requireHost(state, command.guestId);
  const target = state.players.find((player) => player.playerId === command.targetPlayerId);
  if (!target || target.left || target.isBot || !target.connected || target.playerId === host.playerId) {
    return reject("INVALID_OPTION", "Host nur an eine verbundene Person übertragen");
  }
  tx.effects.push({ type: "notice", code: "HOST_CHANGED" });
  requestPersist(tx, "host");
  return { ...state, hostPlayerId: target.playerId };
}

/** Länge der Vorschlags-IDs (ADR-053). */
const SUGGESTION_ID_LENGTH = 12;

/** Offener Vorschlag zur ID – sonst Ablehnung (ersetzt, zurückgezogen oder schon entschieden). */
function requirePendingSuggestion(state: LobbyState, suggestionId: string): SettingsSuggestion {
  const suggestion = state.suggestions.find((entry) => entry.id === suggestionId);
  if (suggestion?.status !== "pending") return reject("INVALID_OPTION", "Vorschlag ist nicht mehr offen");
  return suggestion;
}

/** Einstellungen mit den Änderungen `changes` (validiert); „Personen maximal“ nie unter der Personenzahl. */
function settingsWithChanges(state: LobbyState, changes: unknown): LobbySettings {
  const parsed = settingsChangesSchema.safeParse(changes);
  if (!parsed.success) return reject("VALIDATION_FAILED", "Ungültige Einstellungen im Vorschlag");
  const settings = applySettingsUpdate(state.settings, parsed.data);
  checkSettings(state, settings);
  return settings;
}

function resolveSuggestion(
  state: LobbyState,
  suggestionId: string,
  status: Exclude<SuggestionStatus, "pending">,
): SettingsSuggestion[] {
  return state.suggestions.map((entry) => (entry.id === suggestionId ? { ...entry, status } : entry));
}

/**
 * Vorschlag für die Einstellungen (ADR-053): alle außer dem Host, nur in der Lobby und solange Vorschläge erlaubt
 * sind. Gespeichert werden nur Felder, die vom aktuellen Stand abweichen; ein neuer Vorschlag ersetzt den bisherigen
 * der Person (neue ID, auch nach einer Entscheidung).
 */
export function onSuggestSettings(state: LobbyState, command: SuggestSettingsCommand, tx: Tx): LobbyState {
  const player = requireMember(state, command.guestId);
  if (state.phase !== "lobby") reject("INVALID_PHASE", "Vorschläge nur vor Spielbeginn");
  if (player.playerId === state.hostPlayerId) reject("INVALID_OPTION", "Der Host ändert die Einstellungen direkt");
  if (!state.settings.allowSuggestions) reject("INVALID_OPTION", "Vorschläge sind ausgeschaltet");
  const changes = settingsChangesBetween(state.settings, settingsWithChanges(state, command.changes));
  if (changes === null) return reject("INVALID_OPTION", "Der Vorschlag ändert nichts");
  const suggestion: SettingsSuggestion = {
    id: uniqueRandomId(tx.rng, new Set(state.suggestions.map((entry) => entry.id)), SUGGESTION_ID_LENGTH),
    playerId: player.playerId,
    changes,
    status: "pending",
    at: tx.now,
  };
  return {
    ...state,
    suggestions: [...state.suggestions.filter((entry) => entry.playerId !== player.playerId), suggestion],
  };
}

/** Eigenen Vorschlag zurückziehen (ADR-053) – ohne Vorschlag ändert sich nichts. */
export function onWithdrawSuggestion(state: LobbyState, command: WithdrawSuggestionCommand): LobbyState {
  const player = requireMember(state, command.guestId);
  if (state.phase !== "lobby") reject("INVALID_PHASE", "Vorschläge nur vor Spielbeginn");
  if (!state.suggestions.some((entry) => entry.playerId === player.playerId)) return state;
  return { ...state, suggestions: state.suggestions.filter((entry) => entry.playerId !== player.playerId) };
}

/**
 * Host übernimmt einen offenen Vorschlag (ADR-053): ohne `changes` wie vorgeschlagen, sonst in seiner Fassung (er
 * kann vorher noch anpassen). Der Vorschlag bleibt als „übernommen“ stehen, damit die Person es erfährt.
 */
export function onAcceptSuggestion(state: LobbyState, command: AcceptSuggestionCommand, tx: Tx): LobbyState {
  requireHost(state, command.guestId);
  if (state.phase !== "lobby") reject("INVALID_PHASE", "Vorschläge nur vor Spielbeginn");
  const suggestion = requirePendingSuggestion(state, command.suggestionId);
  const settings = settingsWithChanges(state, command.changes ?? suggestion.changes);
  requestPersist(tx, "settings");
  return { ...state, settings, suggestions: resolveSuggestion(state, suggestion.id, "accepted") };
}

/** Host lehnt einen offenen Vorschlag ab (ADR-053); die Einstellungen bleiben, wie sie sind. */
export function onDeclineSuggestion(state: LobbyState, command: DeclineSuggestionCommand): LobbyState {
  requireHost(state, command.guestId);
  if (state.phase !== "lobby") reject("INVALID_PHASE", "Vorschläge nur vor Spielbeginn");
  const suggestion = requirePendingSuggestion(state, command.suggestionId);
  return { ...state, suggestions: resolveSuggestion(state, suggestion.id, "declined") };
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
  // Mitspielende: ohne den Host, wenn er nur anzeigt (ADR-046).
  const players = connectedMembers(state).filter((player) => !isSpectatingHost(state, player.playerId));
  if (players.length < GAME_RULES.minPlayers) {
    reject("NOT_ENOUGH_PLAYERS", "Mindestens 2 verbundene Mitspielende nötig");
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
