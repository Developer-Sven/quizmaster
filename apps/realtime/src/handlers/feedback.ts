/**
 * „Fragen ansehen“, Bewerten und Melden (docs/01 §Spielende, docs/05; Speicherung docs/08 §5):
 *
 * | Event | Ablauf | Fehlercodes (neben VALIDATION_FAILED/RATE_LIMITED aus der Pipeline) |
 * |---|---|---|
 * | `game:review` | Mitglied, Phase `game_over` → eigene Bewertungen/Meldungen laden → `toReviewItems` | LOBBY_NOT_FOUND, KICKED, RESIGNED, INVALID_PHASE |
 * | `question:rate` | Mitglied, Frage in DIESEM Spiel gezeigt (`findShownQuestion`) → `ratings.rate` (überschreibbar) | LOBBY_NOT_FOUND, KICKED, RESIGNED, INVALID_OPTION |
 * | `question:report` | wie rate → `reports.create` (einmal je Gast und Frage) | LOBBY_NOT_FOUND, KICKED, RESIGNED, INVALID_OPTION |
 *
 * Clients kennen nur Instanz-IDs; die DB-ID löst ausschließlich der Server auf. Diese Events lesen den
 * Zustand nur (keine Änderung) und laufen daher nicht durch die Warteschlange der Lobby.
 */
import { findShownQuestion, reviewQuestionIds, toReviewItems } from "@quizmaster/game-engine";
import { ProtocolError } from "@quizmaster/shared";
import { lobbyOfSocket, type RegisterEvent, type RuntimeAccess, requireMember } from "./common.ts";

export function registerFeedbackHandlers(registerEvent: RegisterEvent, runtime: RuntimeAccess): void {
  registerEvent("game:review", async (_payload, ctx) => {
    const rt = runtime();
    const actor = lobbyOfSocket(rt, ctx.socket, ctx.guestId);
    // Stand zum Zeitpunkt der Anfrage (eine Revanche während des Ladens ändert den Rückblick nicht mehr).
    const state = actor.state;
    const player = requireMember(state, ctx.guestId);
    if (state.phase !== "game_over") throw new ProtocolError("INVALID_PHASE", "Rückblick nur nach Spielende");
    const context = await rt.feedback.reviewContext(ctx.guestId, reviewQuestionIds(state));
    return toReviewItems(state, player.playerId, context);
  });

  registerEvent("question:rate", async (payload, ctx) => {
    const rt = runtime();
    const actor = lobbyOfSocket(rt, ctx.socket, ctx.guestId);
    const state = actor.state;
    requireMember(state, ctx.guestId);
    const shown = findShownQuestion(state, payload.questionId);
    if (shown === null) throw new ProtocolError("INVALID_OPTION", "Frage wurde in diesem Spiel nicht gezeigt");
    await rt.feedback.rate(shown.questionId, ctx.guestId, payload.value);
    return null;
  });

  registerEvent("question:report", async (payload, ctx) => {
    const rt = runtime();
    const actor = lobbyOfSocket(rt, ctx.socket, ctx.guestId);
    const state = actor.state;
    requireMember(state, ctx.guestId);
    const shown = findShownQuestion(state, payload.questionId);
    if (shown === null) throw new ProtocolError("INVALID_OPTION", "Frage wurde in diesem Spiel nicht gezeigt");
    const result = await rt.feedback.report({
      questionId: shown.questionId,
      guestId: ctx.guestId,
      reason: payload.reason,
      lobbyCode: state.code,
    });
    ctx.log.info({ result, reason: payload.reason }, "Frage gemeldet");
    return null;
  });
}
