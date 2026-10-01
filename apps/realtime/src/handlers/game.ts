/**
 * Spiel-Events (docs/05 §Client → Server, §Fairness & Anti-Cheat) → Engine-Commands:
 *
 * | Event | Command | Fehlercodes (neben VALIDATION_FAILED/RATE_LIMITED aus der Pipeline) |
 * |---|---|---|
 * | `game:pick` | PICK | LOBBY_NOT_FOUND, INVALID_PHASE, NOT_YOUR_TURN, INVALID_OPTION, RESIGNED |
 * | `game:answer` | ANSWER | LOBBY_NOT_FOUND, INVALID_PHASE, INVALID_OPTION, TOO_EARLY, TOO_LATE, ALREADY_ANSWERED, RESIGNED |
 * | `game:rematch` | REMATCH | LOBBY_NOT_FOUND, NOT_HOST, INVALID_PHASE, NOT_ENOUGH_PLAYERS |
 *
 * Das Ack auf `game:answer` ist IMMER genau `{ accepted: true }` – nie richtig/falsch (docs/06 Invariante 3);
 * das Ack-Schema (`z.literal(true)`, strictObject) prüft der Kern zusätzlich. Die Auflösung kommt für alle
 * gleichzeitig mit `lobby:state` in Phase `reveal`.
 */
import { lobbyOfSocket, type RegisterEvent, type RuntimeAccess, runCommand } from "./common.ts";

/** Einzige erlaubte Ack-Antwort auf eine angenommene Antwort. */
const ANSWER_ACCEPTED = Object.freeze({ accepted: true as const });

export function registerGameHandlers(registerEvent: RegisterEvent, runtime: RuntimeAccess): void {
  registerEvent("game:pick", (payload, ctx) => {
    const actor = lobbyOfSocket(runtime(), ctx.socket, ctx.guestId);
    return runCommand(ctx, actor, { type: "PICK", guestId: ctx.guestId, categoryId: payload.categoryId }, null);
  });

  registerEvent("game:answer", (payload, ctx) => {
    const actor = lobbyOfSocket(runtime(), ctx.socket, ctx.guestId);
    return runCommand(
      ctx,
      actor,
      { type: "ANSWER", guestId: ctx.guestId, questionId: payload.questionId, choice: payload.choice },
      { ...ANSWER_ACCEPTED },
    );
  });

  registerEvent("game:continue", (payload, ctx) => {
    const actor = lobbyOfSocket(runtime(), ctx.socket, ctx.guestId);
    return runCommand(ctx, actor, { type: "CONTINUE", guestId: ctx.guestId, phase: payload.phase }, null);
  });

  registerEvent("game:rematch", (_payload, ctx) => {
    const actor = lobbyOfSocket(runtime(), ctx.socket, ctx.guestId);
    return runCommand(ctx, actor, { type: "REMATCH", guestId: ctx.guestId }, null);
  });
}
