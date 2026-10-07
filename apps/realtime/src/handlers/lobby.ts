/**
 * Lobby-Events (docs/05 §Client → Server) → Engine-Commands:
 *
 * | Event | Command | Fehlercodes (neben VALIDATION_FAILED/RATE_LIMITED aus der Pipeline) |
 * |---|---|---|
 * | `lobby:create` | LEAVE in bisherigen Lobbys (ADR-042), dann `createLobby` | TURNSTILE_REQUIRED, NAME_REJECTED, RATE_LIMITED (paralleles Erstellen), LOBBY_CREATION_DISABLED, SERVER_BUSY |
 * | `lobby:join` | JOIN (Mitglied → wie RECONNECT) | LOBBY_NOT_FOUND, TURNSTILE_REQUIRED, NAME_REJECTED, KICKED, GAME_IN_PROGRESS, LOBBY_FULL |
 * | `lobby:resume` | RECONNECT | LOBBY_NOT_FOUND, KICKED, RESIGNED |
 * | `lobby:leave` | LEAVE (im Spiel = Aufgeben) | LOBBY_NOT_FOUND, KICKED, RESIGNED |
 * | `lobby:update-settings` | UPDATE_SETTINGS | NOT_HOST, INVALID_PHASE, INVALID_OPTION |
 * | `lobby:rename` | RENAME (ADR-041) | NAME_REJECTED, INVALID_PHASE, LOBBY_NOT_FOUND |
 * | `lobby:transfer-host` | TRANSFER_HOST (ADR-047) | NOT_HOST, INVALID_OPTION |
 * | `lobby:kick` | KICK (+ Lobby-Sperre) | NOT_HOST, INVALID_OPTION |
 * | `lobby:start` | START | NOT_HOST, INVALID_PHASE, NOT_ENOUGH_PLAYERS |
 *
 * Fehlgeschlagene `lobby:join`/`lobby:resume` zählen als Fehlversuch je IP (Code-Raten, Regeln
 * `event.lobby-join.failed.ip` bzw. `event.lobby-resume.failed.ip` aus shared; verbucht von der Event-Registry des
 * Kerns) – aber nur LOBBY_NOT_FOUND (`countsAsCodeGuess`): Ablehnungen eines existierenden Codes (LOBBY_FULL,
 * GAME_IN_PROGRESS, NAME_REJECTED, KICKED, RESIGNED) setzen den richtigen Code voraus und helfen beim Raten nicht;
 * sie zu zählen sperrte nur Gruppen hinter derselben IP (Schule, CGNAT) aus. Eine bestehende Sperre gilt nicht für
 * Mitglieder der angefragten Lobby (Rückkehr in die eigene Lobby ist kein Raten, `skipFailureBlock`).
 *
 * Sockets: create/join/resume nehmen den Socket VOR dem Command in den Lobby-Raum auf (Ablehnung → wieder
 * heraus); nach einem erfolgreichen LEAVE verlassen alle Sockets der Person den Raum.
 */
import { type Command, findPlayerByGuestId, type LobbyState } from "@quizmaster/game-engine";
import { type ErrorCode, isProtocolError, ProtocolError } from "@quizmaster/shared";
import type { LobbyActor } from "../lobby/lobby-actor.ts";
import type { AckSent } from "../registry/types.ts";
import {
  type HandlerRuntime,
  lobbyByCode,
  lobbyOfSocket,
  moderateName,
  type RegisterEvent,
  type RuntimeAccess,
  requireTurnstile,
  runCommand,
} from "./common.ts";

/** Fehlercodes, nach denen die Person sicher kein Mitglied (mehr) ist – ihre Sockets verlassen den Raum. */
const NOT_A_MEMBER = new Set(["LOBBY_NOT_FOUND", "KICKED", "RESIGNED"]);

/** Fehlversuch für die IP-Regeln von join/resume: nur ein unbekannter bzw. fremder Code (Code-Raten). */

/** Kategorie-Auswahl (ADR-048): nur spielbare Kategorien des Katalogs – sonst INVALID_OPTION. */
function assertPlayableCategories(rt: HandlerRuntime, categoryIds: readonly string[] | null | undefined): void {
  if (!categoryIds) return;
  const playable = new Set(rt.questions.playableCategories().map((option) => option.id));
  if (categoryIds.some((id) => !playable.has(id))) {
    throw new ProtocolError("INVALID_OPTION", "Unbekannte oder nicht spielbare Kategorie");
  }
}

export function countsAsCodeGuess(code: ErrorCode): boolean {
  return code === "LOBBY_NOT_FOUND";
}

/**
 * Mitglied der angefragten Lobby? Dann gilt eine Fehlversuchs-Sperre der IP nicht (Reconnect, Beitrittslink erneut
 * geöffnet). Verrät nichts: Für alle anderen bleibt die Antwort gleich – egal, ob der Code existiert.
 */
function isMemberOfRequestedLobby(runtime: RuntimeAccess) {
  return (payload: { code: string }, guestId: string): boolean =>
    runtime().lobbies.get(payload.code)?.isMember(guestId) === true;
}

/** LEAVE in einer Lobby ohne Ack (wie `lobby:leave`); danach verlassen die Sockets der Person den Raum. */
async function leaveLobby(actor: LobbyActor, guestId: string): Promise<void> {
  const result = await actor.dispatch({ type: "LEAVE", guestId });
  if (result.ok || NOT_A_MEMBER.has(result.error.code)) {
    actor.detachGuest(guestId);
    return;
  }
  throw new ProtocolError(result.error.code, result.error.message);
}

/**
 * Wer eine neue Lobby erstellt, verlässt alle bisherigen (ADR-042): Eine liegen gebliebene Mitgliedschaft
 * (Tab geschlossen, Fehler beim Wechsel) sperrte sonst mit „Zu viele Versuche“, bis die alte Lobby schließt. Im
 * laufenden Spiel heißt Verlassen Aufgeben – wie beim Tippen auf „Lobby verlassen“. Deshalb erst, wenn die neue
 * Lobby angelegt ist (Zulassung und Datenbank haben zugestimmt) – eine abgelehnte Erstellung kostet nichts.
 */
async function leaveAllLobbies(rt: HandlerRuntime, guestId: string): Promise<void> {
  for (const actor of rt.lobbies.membershipsOf(guestId)) await leaveLobby(actor, guestId);
}

export function registerLobbyHandlers(registerEvent: RegisterEvent, runtime: RuntimeAccess): void {
  registerEvent("lobby:create", async (payload, ctx) => {
    const rt = runtime();
    const config = rt.appConfig.get();
    requireTurnstile(config, ctx.socket.data.ticketTsv, ctx.now);
    const name = moderateName(payload.name, config.blockedTerms);
    let sent: AckSent | undefined;
    await rt.lobbies.create({
      socket: ctx.socket,
      guestId: ctx.guestId,
      name,
      onCreated: (code) => {
        sent = ctx.ack({ code });
      },
      leavePrevious: () => leaveAllLobbies(rt, ctx.guestId),
    });
    if (sent === undefined) throw new Error("Ack wurde nicht gesendet");
    return sent;
  });

  const codeGuessing = { countsAsFailure: countsAsCodeGuess, skipFailureBlock: isMemberOfRequestedLobby(runtime) };

  registerEvent(
    "lobby:join",
    (payload, ctx) => {
      const rt = runtime();
      const config = rt.appConfig.get();
      const found = rt.lobbies.get(payload.code);
      // Notfall-Schalter VOR der Code-Prüfung (außer für Mitglieder): ohne Turnstile verrät der Beitritt nicht,
      // ob ein Code existiert (TURNSTILE_REQUIRED zählt nicht als Fehlversuch).
      if (found === undefined || !found.isMember(ctx.guestId)) {
        requireTurnstile(config, ctx.socket.data.ticketTsv, ctx.now);
      }
      const actor = found ?? lobbyByCode(rt, payload.code);
      // Läuft in der Warteschlange der Lobby: Mitgliedschaft und Namensprüfung sehen denselben Zustand wie JOIN.
      const join = (state: LobbyState): Command => {
        const member = findPlayerByGuestId(state, ctx.guestId);
        if (member !== undefined && !member.left) return { type: "JOIN", guestId: ctx.guestId, name: member.name };
        requireTurnstile(config, ctx.socket.data.ticketTsv, ctx.now);
        return { type: "JOIN", guestId: ctx.guestId, name: moderateName(payload.name, config.blockedTerms) };
      };
      return runCommand(ctx, actor, join, { code: actor.code }, { attach: ctx.socket });
    },
    codeGuessing,
  );

  registerEvent(
    "lobby:resume",
    (payload, ctx) => {
      const actor = lobbyByCode(runtime(), payload.code);
      return runCommand(
        ctx,
        actor,
        { type: "RECONNECT", guestId: ctx.guestId },
        { code: actor.code },
        { attach: ctx.socket },
      );
    },
    codeGuessing,
  );

  registerEvent("lobby:leave", async (_payload, ctx) => {
    const actor = lobbyOfSocket(runtime(), ctx.socket, ctx.guestId);
    try {
      const sent = await runCommand(ctx, actor, { type: "LEAVE", guestId: ctx.guestId }, null);
      actor.detachGuest(ctx.guestId);
      return sent;
    } catch (error) {
      if (isProtocolError(error) && NOT_A_MEMBER.has(error.code)) actor.detachGuest(ctx.guestId);
      throw error;
    }
  });

  registerEvent("lobby:update-settings", (payload, ctx) => {
    const rt = runtime();
    assertPlayableCategories(rt, payload.categoryIds);
    const actor = lobbyOfSocket(rt, ctx.socket, ctx.guestId);
    return runCommand(ctx, actor, { type: "UPDATE_SETTINGS", guestId: ctx.guestId, update: payload }, null);
  });

  registerEvent("lobby:rename", (payload, ctx) => {
    const rt = runtime();
    const actor = lobbyOfSocket(rt, ctx.socket, ctx.guestId);
    const name = moderateName(payload.name, rt.appConfig.get().blockedTerms);
    return runCommand(ctx, actor, { type: "RENAME", guestId: ctx.guestId, name }, null);
  });

  registerEvent("lobby:transfer-host", (payload, ctx) => {
    const actor = lobbyOfSocket(runtime(), ctx.socket, ctx.guestId);
    return runCommand(
      ctx,
      actor,
      { type: "TRANSFER_HOST", guestId: ctx.guestId, targetPlayerId: payload.playerId },
      null,
    );
  });

  // Vorschläge für die Einstellungen (ADR-053); Kategorien wie beim Host nur aus dem Katalog.
  registerEvent("lobby:suggest-settings", (payload, ctx) => {
    const rt = runtime();
    assertPlayableCategories(rt, payload.categoryIds);
    const actor = lobbyOfSocket(rt, ctx.socket, ctx.guestId);
    return runCommand(ctx, actor, { type: "SUGGEST_SETTINGS", guestId: ctx.guestId, changes: payload }, null);
  });

  registerEvent("lobby:withdraw-suggestion", (_payload, ctx) => {
    const actor = lobbyOfSocket(runtime(), ctx.socket, ctx.guestId);
    return runCommand(ctx, actor, { type: "WITHDRAW_SUGGESTION", guestId: ctx.guestId }, null);
  });

  registerEvent("lobby:accept-suggestion", (payload, ctx) => {
    const rt = runtime();
    assertPlayableCategories(rt, payload.changes?.categoryIds);
    const actor = lobbyOfSocket(rt, ctx.socket, ctx.guestId);
    return runCommand(
      ctx,
      actor,
      { type: "ACCEPT_SUGGESTION", guestId: ctx.guestId, suggestionId: payload.id, changes: payload.changes },
      null,
    );
  });

  registerEvent("lobby:decline-suggestion", (payload, ctx) => {
    const actor = lobbyOfSocket(runtime(), ctx.socket, ctx.guestId);
    return runCommand(ctx, actor, { type: "DECLINE_SUGGESTION", guestId: ctx.guestId, suggestionId: payload.id }, null);
  });

  registerEvent("lobby:kick", (payload, ctx) => {
    const actor = lobbyOfSocket(runtime(), ctx.socket, ctx.guestId);
    return runCommand(ctx, actor, { type: "KICK", guestId: ctx.guestId, targetPlayerId: payload.playerId }, null);
  });

  registerEvent("lobby:start", (_payload, ctx) => {
    const actor = lobbyOfSocket(runtime(), ctx.socket, ctx.guestId);
    return runCommand(ctx, actor, { type: "START", guestId: ctx.guestId }, null);
  });
}
