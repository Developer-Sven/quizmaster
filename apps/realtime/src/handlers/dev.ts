/**
 * Dev-Bots (docs/05 §Dev-Bots): `dev:add-bot` → ADD_BOT. Registriert wird der Handler zwar immer, die
 * Event-Registry des Kerns nimmt ihn aber nur mit `DEV_BOTS_ENABLED=true` auf (sonst gilt das Event als
 * unbekannt) – in Produktion verbietet die Env-Prüfung die Bots ohnehin.
 *
 * | Event | Command | Fehlercodes |
 * |---|---|---|
 * | `dev:add-bot` | ADD_BOT | LOBBY_NOT_FOUND, NOT_HOST, INVALID_PHASE, LOBBY_FULL (voll oder schon 7 Bots) |
 */
import { lobbyOfSocket, type RegisterEvent, type RuntimeAccess, runCommand } from "./common.ts";

export function registerDevHandlers(registerEvent: RegisterEvent, runtime: RuntimeAccess): boolean {
  return registerEvent("dev:add-bot", (_payload, ctx) => {
    const actor = lobbyOfSocket(runtime(), ctx.socket, ctx.guestId);
    return runCommand(ctx, actor, { type: "ADD_BOT", guestId: ctx.guestId }, null);
  });
}
