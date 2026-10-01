/**
 * „Fragen ansehen“ (docs/01 §Spielende, docs/05 `game:review`) und Feedback (`question:rate`,
 * `question:report`; Speicherung docs/08 §5): Rückblick mit Lösung und allen Antworten, Bewertung
 * überschreibbar, Meldung einmal je Person und Frage, nur für in diesem Spiel gezeigte Fragen.
 */
import { findShownQuestion } from "@quizmaster/game-engine";
import { questionRatingId } from "@quizmaster/shared/documents";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestServer } from "../helpers/index.ts";
import {
  actorOf,
  autoPlay,
  connectGuest,
  createLobby,
  joinLobby,
  lastSelf,
  startGameServer,
  waitForGameDoc,
  waitForPhase,
} from "./support.ts";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startGameServer();
});
afterAll(() => server?.cleanup());

describe("Rückblick, Bewertung, Meldung", () => {
  it("game:review liefert alle Fragen mit Lösung und Antworten; rate/report werden gespeichert", async () => {
    const host = await connectGuest(server, { guestDoc: true });
    const guest = await connectGuest(server, { guestDoc: true });
    const outsider = await connectGuest(server);
    const code = await createLobby(host, "Mia");
    await joinLobby(guest, code, "Ben");
    await host.emit("lobby:update-settings", { rounds: 1, questionsPerCategory: 2 });
    expect(await guest.emit("game:review", {})).toMatchObject({ ok: false, error: { code: "INVALID_PHASE" } });
    expect(await guest.emit("question:rate", { questionId: "unbekannt", value: 1 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OPTION" },
    });

    const players = [autoPlay(server, host, code), autoPlay(server, guest, code, { answer: "wrong" })];
    const over = waitForPhase(host, "game_over", 60_000);
    expect((await host.emit("lobby:start", {})).ok).toBe(true);
    await over;
    for (const player of players) player.stop();
    const actor = actorOf(server, code);
    await waitForGameDoc(server, actor.lobbyId);
    const hostId = lastSelf(host)?.playerId ?? "";
    const guestId = lastSelf(guest)?.playerId ?? "";

    const review = await guest.emit("game:review", {});
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.data).toHaveLength(4);
    for (const item of review.data) {
      expect(item.answers).toHaveLength(4);
      expect(item.picks[hostId]).toBe(item.correct);
      expect(item.picks[guestId]).not.toBe(item.correct);
      expect(item.picks[guestId]).not.toBeNull();
      expect(item).toMatchObject({ myRating: null, myReported: false });
    }
    const [first, second] = review.data;
    if (first === undefined || second === undefined) throw new Error("Rückblick unvollständig");
    const shown = findShownQuestion(actor.state, first.questionId);
    if (shown === null) throw new Error("Frage nicht zuordenbar");
    const dbId = shown.questionId;
    expect(first.questionId).not.toBe(dbId);

    // Bewertung: einmal je Person und Frage, überschreibbar; Zähler der Frage passen sich an.
    expect(await guest.emit("question:rate", { questionId: first.questionId, value: 1 })).toEqual({
      ok: true,
      data: null,
    });
    const ratingId = questionRatingId(dbId, guest.guestId);
    expect((await server.db.collections.questionRatings.findOne({ _id: ratingId }))?.value).toBe(1);
    expect(await guest.emit("question:rate", { questionId: first.questionId, value: -1 })).toEqual({
      ok: true,
      data: null,
    });
    expect((await server.db.collections.questionRatings.findOne({ _id: ratingId }))?.value).toBe(-1);
    expect(await server.db.collections.questionRatings.countDocuments({ questionId: dbId })).toBe(1);
    const rated = await server.db.collections.questions.findOne({ _id: dbId });
    expect(rated?.stats).toMatchObject({ likes: 0, dislikes: 1 });

    // Meldung: einmal je Person und Frage (eine zweite wird still ignoriert).
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await guest.emit("question:report", { questionId: first.questionId, reason: "falsch" })).toEqual({
        ok: true,
        data: null,
      });
    }
    const reports = await server.db.collections.questionReports.find({ questionId: dbId }).toArray();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reason: "falsch", guestId: guest.guestId, lobbyCode: code, status: "open" });
    expect((await server.db.collections.questions.findOne({ _id: dbId }))?.stats.reports).toBe(1);

    const again = await guest.emit("game:review", {});
    if (!again.ok) throw new Error(`Rückblick abgelehnt: ${again.error.code}`);
    expect(again.data[0]).toMatchObject({ questionId: first.questionId, myRating: -1, myReported: true });
    expect(again.data[1]).toMatchObject({ questionId: second.questionId, myRating: null, myReported: false });
    // Eigene Markierungen gelten nur für die eigene Person.
    const hostReview = await host.emit("game:review", {});
    if (!hostReview.ok) throw new Error(`Rückblick abgelehnt: ${hostReview.error.code}`);
    expect(hostReview.data[0]).toMatchObject({ myRating: null, myReported: false });

    expect(await guest.emit("question:rate", { questionId: "Zzzzzzzzzzzz", value: 1 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_OPTION" },
    });
    expect(await outsider.emit("question:rate", { questionId: first.questionId, value: 1 })).toMatchObject({
      ok: false,
      error: { code: "LOBBY_NOT_FOUND" },
    });
    expect(await outsider.emit("game:review", {})).toMatchObject({ ok: false, error: { code: "LOBBY_NOT_FOUND" } });
    expect(guest.contractViolations).toEqual([]);
    for (const client of [host, guest, outsider]) client.close();
  });
});
