/**
 * Lobby-Events (docs/05 §Client → Server) → Engine-Commands:
 *
 * | Event | Command | Fehlercodes (neben VALIDATION_FAILED/RATE_LIMITED aus der Pipeline) |
 * |---|---|---|
 * | `lobby:create` | `createLobby` | TURNSTILE_REQUIRED, NAME_REJECTED, RATE_LIMITED (schon Mitglied einer aktiven Lobby), LOBBY_CREATION_DISABLED, SERVER_BUSY |
 * | `lobby:join` | JOIN (Mitglied → wie RECONNECT) | LOBBY_NOT_FOUND, TURNSTILE_REQUIRED, NAME_REJECTED, KICKED, GAME_IN_PROGRESS, LOBBY_FULL |
 * | `lobby:resume` | RECONNECT | LOBBY_NOT_FOUND, KICKED, RESIGNED |
 * | `lobby:leave` | LEAVE (im Spiel = Aufgeben) | LOBBY_NOT_FOUND, KICKED, RESIGNED |
 * | `lobby:update-settings` | UPDATE_SETTINGS | NOT_HOST, INVALID_PHASE, INVALID_OPTION |
 * | `lobby:kick` | KICK (+ Lobby-Sperre) | NOT_HOST, INVALID_OPTION |
 * | `lobby:start` | START | NOT_HOST, INVALID_PHASE, NOT_ENOUGH_PLAYERS |
 *
 * Fehlgeschlagene `lobby:join` zählen als Fehlversuch je IP (Code-Raten, Regel `event.lobby-join.failed.ip`
 * aus shared) – das erledigt die Event-Registry des Kerns für jede fachliche Ablehnung. `lobby:resume` hat eine
 * eigene Regel (`event.lobby-resume.failed.ip`); dort zählt nur LOBBY_NOT_FOUND (KICKED/RESIGNED setzen eine
 * frühere Mitgliedschaft voraus und helfen beim Raten nicht).
 *
 * Sockets: create/join/resume nehmen den Socket VOR dem Command in den Lobby-Raum auf (Ablehnung → wieder
 * heraus); nach einem erfolgreichen LEAVE verlassen alle Sockets der Person den Raum.
 */
import { type Command, findPlayerByGuestId, type LobbyState } from "@quizmaster/game-engine";
import { type ErrorCode, isProtocolError } from "@quizmaster/shared";
import type { AckSent } from "../registry/types.ts";
import {
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

/** Fehlversuch für `event.lobby-resume.failed.ip`: nur ein unbekannter bzw. fremder Code (Code-Raten). */
export function countsAsResumeFailure(code: ErrorCode): boolean {
  return code === "LOBBY_NOT_FOUND";
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
    });
    if (sent === undefined) throw new Error("Ack wurde nicht gesendet");
    return sent;
  });

  registerEvent("lobby:join", (payload, ctx) => {
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
  });

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
    { countsAsFailure: countsAsResumeFailure },
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
    const actor = lobbyOfSocket(runtime(), ctx.socket, ctx.guestId);
    return runCommand(ctx, actor, { type: "UPDATE_SETTINGS", guestId: ctx.guestId, update: payload }, null);
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
