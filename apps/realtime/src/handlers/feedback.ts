/**
 * „Fragen ansehen“, Bewerten und Melden (docs/01 §Spielende, docs/05; Speicherung docs/08 §5):
 *
 * | Event | Ablauf | Fehlercodes (neben VALIDATION_FAILED/RATE_LIMITED aus der Pipeline) |
 * |---|---|---|
 * | `game:review` | Mitspielende des beendeten Spiels – in `game_over` bzw. danach in `lobby` (`lastGame`, ADR-038) → eigene Bewertungen/Meldungen laden → `toReviewItems` | LOBBY_NOT_FOUND, KICKED, RESIGNED, INVALID_PHASE |
 * | `question:rate` | Mitglied, Frage in DIESEM bzw. dem zuletzt beendeten Spiel gezeigt (`findShownQuestion`); nach Spielende nur Mitspielende → `ratings.rate` (überschreibbar) | LOBBY_NOT_FOUND, KICKED, RESIGNED, INVALID_OPTION |
 * | `question:report` | wie rate → `reports.create` (einmal je Gast und Frage) | LOBBY_NOT_FOUND, KICKED, RESIGNED, INVALID_OPTION |
 *
 * Clients kennen nur Instanz-IDs; die DB-ID löst ausschließlich der Server auf. Diese Events lesen den
 * Zustand nur (keine Änderung) und laufen daher nicht durch die Warteschlange der Lobby.
 */
import {
  findShownQuestion,
  finishedGame,
  playedFinishedGame,
  reviewQuestionIds,
  toReviewItems,
} from "@quizmaster/game-engine";
import { ProtocolError } from "@quizmaster/shared";
import { lobbyOfSocket, type RegisterEvent, type RuntimeAccess, requireMember } from "./common.ts";

export function registerFeedbackHandlers(registerEvent: RegisterEvent, runtime: RuntimeAccess): void {
  registerEvent("game:review", async (_payload, ctx) => {
    const rt = runtime();
    const actor = lobbyOfSocket(rt, ctx.socket, ctx.guestId);
    // Stand zum Zeitpunkt der Anfrage (eine Revanche während des Ladens ändert den Rückblick nicht mehr).
    const state = actor.state;
    const player = requireMember(state, ctx.guestId);
    if (finishedGame(state) === null) throw new ProtocolError("INVALID_PHASE", "Rückblick nur nach Spielende");
    if (!playedFinishedGame(state, player.playerId)) {
      throw new ProtocolError("INVALID_PHASE", "Rückblick nur für Mitspielende");
    }
    const context = await rt.feedback.reviewContext(ctx.guestId, reviewQuestionIds(state));
    return toReviewItems(state, player.playerId, context);
  });

  registerEvent("question:rate", async (payload, ctx) => {
    const rt = runtime();
    const actor = lobbyOfSocket(rt, ctx.socket, ctx.guestId);
    const state = actor.state;
    const player = requireMember(state, ctx.guestId);
    const shown = findShownQuestion(state, payload.questionId);
    if (shown === null || !mayGiveFeedback(state, player.playerId)) {
      throw new ProtocolError("INVALID_OPTION", "Frage wurde in diesem Spiel nicht gezeigt");
    }
    // Herkunft für die Schutzautomatik (ADR-058): nur der HMAC-IP-Schlüssel und der Lobby-Code.
    await rt.feedback.rate(shown.questionId, ctx.guestId, payload.value, { ipKey: ctx.ipKey, lobbyCode: state.code });
    return null;
  });

  registerEvent("question:report", async (payload, ctx) => {
    const rt = runtime();
    const actor = lobbyOfSocket(rt, ctx.socket, ctx.guestId);
    const state = actor.state;
    const player = requireMember(state, ctx.guestId);
    const shown = findShownQuestion(state, payload.questionId);
    if (shown === null || !mayGiveFeedback(state, player.playerId)) {
      throw new ProtocolError("INVALID_OPTION", "Frage wurde in diesem Spiel nicht gezeigt");
    }
    const result = await rt.feedback.report({
      questionId: shown.questionId,
      guestId: ctx.guestId,
      reason: payload.reason,
      lobbyCode: state.code,
      ipKey: ctx.ipKey,
    });
    ctx.log.info({ result, reason: payload.reason }, "Frage gemeldet");
    return null;
  });
}

/**
 * Bewerten/Melden: im laufenden Spiel für Mitglieder (wie bisher), nach Spielende – `game_over` und `lobby` mit
 * `lastGame` – nur für Mitspielende; später Beigetretene haben die Fragen nie gesehen (zählt sonst für die
 * Schutzautomatik, docs/08 §5).
 */
function mayGiveFeedback(state: Parameters<typeof finishedGame>[0], playerId: string): boolean {
  return finishedGame(state) === null || playedFinishedGame(state, playerId);
}
