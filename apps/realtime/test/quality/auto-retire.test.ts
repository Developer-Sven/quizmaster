/**
 * Schutzautomatik und Live-Zähler im laufenden Server (docs/08 §5) gegen die Test-DB:
 *
 * - Ende-zu-Ende: drei Mitspielende melden dieselbe Frage über `question:report` → DB-Status `retired` +
 *   `autoRetired`, der questions-Watcher nimmt sie live aus dem Pool, Metrik `qm_questions_auto_retired_total`.
 * - Schwellen: verschiedene Gäste, nur „falsch/veraltet/mehrdeutig“, 7-Tage-Fenster; Bewertungsquote < 30 % bei
 *   ≥ 20 Bewertungen (genau 30 % bleibt).
 * - Idempotenz/Race: parallele Meldungen ziehen genau einmal zurück.
 * - Bezugszeit: Nach einer Wiederherstellung zählen alte Meldungen nicht erneut.
 * - Live-Zähler: Fällt eine Kategorie unter `appConfig.catalog.minPlayable`, wird sie nicht mehr angeboten
 *   (Kategorien-Watcher); nach der Wiederherstellung wieder.
 * - Missbrauchsbremse: Dieselben drei Gäste melden jede Frage einer Kategorie → höchstens das Tagesbudget je
 *   Kategorie wird zurückgezogen, der Rest bleibt im Pool (Metrik `qm_questions_auto_retire_suppressed_total`).
 *
 * Eigener Port-Bereich 4530–4539.
 */
import { randomUUID } from "node:crypto";
import { AUTO_RETIRE_BUDGET } from "@quizmaster/db";
import { findShownQuestion } from "@quizmaster/game-engine";
import type { ReportReason } from "@quizmaster/shared";
import type { QuestionDoc } from "@quizmaster/shared/documents";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type GameRuntime, gameRuntimeOf } from "../../src/lobby/module.ts";
import { AUTO_RETIRE_SUPPRESSED_METRIC, AUTO_RETIRED_METRIC } from "../../src/services/quality.ts";
import {
  actorOf,
  autoPlay,
  connectGuest,
  createLobby,
  joinLobby,
  waitForGameDoc,
  waitForPhase,
} from "../game/support.ts";
import { eventually, metricValue, startTestServer, type TestServer } from "../helpers/index.ts";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

/** Port-Bereich dieser Suite (W4#3). */
export const QUALITY_TEST_PORTS = { from: 4530, to: 4539 } as const;
const DAY_MS = 24 * 60 * 60 * 1_000;

let server: TestServer;
/** Frage aus dem Fenster-Test, die der Wiederherstellungs-Test weiterverwendet. */
let windowQuestionId = "";

beforeAll(async () => {
  server = await startTestServer({ timing: "fast", ports: QUALITY_TEST_PORTS });
});
afterAll(() => server?.cleanup());

function runtime(): GameRuntime {
  const rt = gameRuntimeOf(server.app);
  if (rt === undefined) throw new Error("Lobby-Modul nicht gestartet");
  return rt;
}

/** Unverifizierte Fixture-Fragen einer Kategorie (stabil sortiert). */
async function unverifiedQuestions(category: string, count: number): Promise<string[]> {
  const docs = await server.db.collections.questions
    .find({ category, status: "unverified" }, { projection: { _id: 1 } })
    .sort({ _id: 1 })
    .limit(count)
    .toArray();
  if (docs.length < count) throw new Error(`Zu wenige Fixture-Fragen in ${category}`);
  return docs.map((doc) => doc._id);
}

async function question(questionId: string): Promise<QuestionDoc> {
  const doc = await server.db.collections.questions.findOne({ _id: questionId });
  if (doc === null) throw new Error(`Frage ${questionId} fehlt`);
  return doc;
}

function report(questionId: string, reason: ReportReason = "falsch", guestId: string = randomUUID()) {
  return runtime().feedback.report({ questionId, guestId, reason, lobbyCode: null });
}

function rate(questionId: string, value: 1 | -1) {
  return runtime().feedback.rate(questionId, randomUUID(), value);
}

function retiredMetric(reason: "reports" | "rating"): Promise<number> {
  return metricValue(server.app.services.metrics, AUTO_RETIRED_METRIC, { reason });
}

function offered(categoryId: string): boolean {
  return runtime()
    .questions.playableCategories()
    .some((category) => category.id === categoryId);
}

describe("Schutzautomatik über Meldungen", () => {
  it("drei Mitspielende melden über question:report → retired, der Watcher nimmt die Frage live aus dem Pool", async () => {
    const host = await connectGuest(server, { guestDoc: true });
    const ben = await connectGuest(server, { guestDoc: true });
    const cleo = await connectGuest(server, { guestDoc: true });
    const code = await createLobby(host, "Mia");
    await joinLobby(ben, code, "Ben");
    await joinLobby(cleo, code, "Cleo");
    expect((await host.emit("lobby:update-settings", { rounds: 1, questionsPerCategory: 1 })).ok).toBe(true);
    const players = [host, ben, cleo].map((client) => autoPlay(server, client, code));
    const over = waitForPhase(host, "game_over", 60_000);
    expect((await host.emit("lobby:start", {})).ok).toBe(true);
    await over;
    for (const player of players) player.stop();
    const actor = actorOf(server, code);
    await waitForGameDoc(server, actor.lobbyId);

    const review = await host.emit("game:review", {});
    if (!review.ok) throw new Error(`Rückblick abgelehnt: ${review.error.code}`);
    const instanceId = review.data[0]?.questionId ?? "";
    const shown = findShownQuestion(actor.state, instanceId);
    if (shown === null) throw new Error("Frage nicht zuordenbar");
    const dbId = shown.questionId;
    expect(runtime().questions.hasQuestion(dbId)).toBe(true);
    const before = await retiredMetric("reports");

    const reasons: ReportReason[] = ["falsch", "veraltet", "mehrdeutig"];
    for (const [index, client] of [host, ben].entries()) {
      expect(
        await client.emit("question:report", { questionId: instanceId, reason: reasons[index] ?? "falsch" }),
      ).toEqual({ ok: true, data: null });
    }
    expect((await question(dbId)).status).not.toBe("retired");
    expect(runtime().questions.hasQuestion(dbId)).toBe(true);

    expect(await cleo.emit("question:report", { questionId: instanceId, reason: "mehrdeutig" })).toEqual({
      ok: true,
      data: null,
    });
    // Das Ack kommt nach der Prüfung: Die Frage ist schon zurückgezogen …
    expect(await question(dbId)).toMatchObject({ status: "retired", autoRetired: { reason: "reports" } });
    // … und der questions-Watcher entfernt sie live aus dem Pool.
    await eventually(() => !runtime().questions.hasQuestion(dbId), 10_000);
    expect(await retiredMetric("reports")).toBe(before + 1);
    // Die Kategorie bleibt spielbar (genug Fragen über der Mindestmenge der Fixtures).
    expect(offered(shown.categoryId)).toBe(true);

    for (const client of [host, ben, cleo]) {
      expect(client.contractViolations).toEqual([]);
      client.close();
    }
  });

  it("zählt nur verschiedene Gäste mit „falsch/veraltet/mehrdeutig“ in den letzten 7 Tagen", async () => {
    const [questionId = ""] = await unverifiedQuestions("kunst-kultur", 1);
    windowQuestionId = questionId;
    // Letzte Änderung lange her, damit allein das 7-Tage-Fenster greift (updatedAt ist kein Pool-Feld).
    await server.db.collections.questions.updateOne(
      { _id: questionId },
      { $set: { updatedAt: new Date(Date.now() - 30 * DAY_MS) } },
    );
    const old = new Date(Date.now() - 8 * DAY_MS);
    await server.db.collections.questionReports.insertMany(
      [randomUUID(), randomUUID()].map((guestId) => ({
        _id: randomUUID(),
        questionId,
        reason: "falsch" as const,
        guestId,
        lobbyCode: null,
        status: "open" as const,
        createdAt: old,
        expiresAt: new Date(old.getTime() + 365 * DAY_MS),
      })),
    );

    const guest = randomUUID();
    expect(await report(questionId, "falsch", guest)).toBe("created");
    expect(await report(questionId, "veraltet", guest)).toBe("duplicate"); // dieselbe Person zählt einmal
    expect(await report(questionId, "tippfehler")).toBe("created"); // Grund zählt nicht
    expect(await report(questionId, "unpassend")).toBe("created");
    expect(await report(questionId, "mehrdeutig")).toBe("created"); // zweiter Gast im Fenster
    expect((await question(questionId)).status).toBe("unverified");
    expect(runtime().questions.hasQuestion(questionId)).toBe(true);

    expect(await report(questionId, "veraltet")).toBe("created"); // dritter Gast → zurückgezogen
    expect(await question(questionId)).toMatchObject({ status: "retired", autoRetired: { reason: "reports" } });
    await eventually(() => !runtime().questions.hasQuestion(questionId), 10_000);
  });

  it("nach der Wiederherstellung zählen alte Meldungen nicht erneut; der Watcher nimmt die Frage wieder auf", async () => {
    const questionId = windowQuestionId;
    const doc = await question(questionId);
    expect(doc.autoRetired).not.toBeNull();
    expect(
      await server.db.repos.questions.restoreAutoRetired(
        questionId,
        { status: "unverified", contentHash: doc.contentHash },
        new Date(),
      ),
    ).toBe(true);
    await eventually(() => runtime().questions.hasQuestion(questionId), 10_000);
    expect(await report(questionId, "falsch")).toBe("created");
    expect(await question(questionId)).toMatchObject({ status: "unverified", autoRetired: null });
    expect(runtime().questions.hasQuestion(questionId)).toBe(true);
  });

  it("parallele Meldungen verschiedener Gäste ziehen die Frage genau einmal zurück", async () => {
    const [questionId = ""] = await unverifiedQuestions("sport-freizeit", 1);
    const before = await retiredMetric("reports");
    const results = await Promise.all(Array.from({ length: 6 }, () => report(questionId, "falsch")));
    expect(results).toEqual(Array(6).fill("created"));
    const doc = await question(questionId);
    expect(doc).toMatchObject({ status: "retired", autoRetired: { reason: "reports" } });
    expect(await retiredMetric("reports")).toBe(before + 1);
    // Erneute Prüfung ist ein No-op.
    expect(await runtime().feedback.quality.afterReport(questionId)).toEqual({ outcome: "skipped", reason: null });
    expect((await question(questionId)).autoRetired).toEqual(doc.autoRetired);
    await eventually(() => !runtime().questions.hasQuestion(questionId), 10_000);
  });
});

describe("Schutzautomatik über Bewertungen", () => {
  it("Quote < 30 % bei ≥ 20 Bewertungen → retired; genau 30 % bleibt im Pool", async () => {
    const [low = "", border = ""] = await unverifiedQuestions("tv-serien", 2);
    const before = await retiredMetric("rating");
    for (let index = 0; index < 5; index++) await rate(low, 1);
    for (let index = 0; index < 14; index++) await rate(low, -1);
    expect((await question(low)).status).toBe("unverified"); // 19 Bewertungen
    const last = await rate(low, -1); // 20 Bewertungen, 25 %
    expect(last.question?.stats).toMatchObject({ likes: 5, dislikes: 15 });
    expect(await question(low)).toMatchObject({
      status: "retired",
      autoRetired: { reason: "rating" },
      stats: { likes: 5, dislikes: 15 },
    });
    await eventually(() => !runtime().questions.hasQuestion(low), 10_000);
    expect(await retiredMetric("rating")).toBe(before + 1);

    for (let index = 0; index < 6; index++) await rate(border, 1);
    for (let index = 0; index < 14; index++) await rate(border, -1);
    expect(await question(border)).toMatchObject({ status: "unverified", autoRetired: null });
    expect(runtime().questions.hasQuestion(border)).toBe(true);
    // Zähler-Konsistenz: Zähler der Frage = gespeicherte Bewertungen.
    expect(await server.db.repos.ratings.summary(border)).toEqual({ likes: 6, dislikes: 14 });
    expect((await question(border)).stats).toMatchObject({ likes: 6, dislikes: 14 });
  });
});

describe("Live-Zähler der Kategorien", () => {
  it("unter der Mindestmenge nicht mehr angeboten, nach der Wiederherstellung wieder", async () => {
    const category = "essen-trinken";
    const counts = await server.db.repos.questions.countPlayable(category);
    expect(offered(category)).toBe(true);
    const original = (await server.db.repos.appConfig.get()).catalog;
    // Mindestmenge genau auf den aktuellen Bestand: eine zurückgezogene Frage reicht zum Unterschreiten.
    await server.db.repos.appConfig.setCatalog({ ...original, minPlayable: counts.playableCount }, new Date());
    try {
      const [questionId = ""] = await unverifiedQuestions(category, 1);
      for (let index = 0; index < 3; index++) await report(questionId, "falsch");
      expect((await question(questionId)).status).toBe("retired");
      expect(await server.db.collections.categories.findOne({ _id: category })).toMatchObject({
        playable: false,
        playableCount: counts.playableCount - 1,
        approvedCount: counts.approvedCount,
      });
      await eventually(() => !offered(category), 10_000);

      const doc = await question(questionId);
      await server.db.repos.questions.restoreAutoRetired(
        questionId,
        { status: "unverified", contentHash: doc.contentHash },
        new Date(),
      );
      const recount = await runtime().feedback.quality.recountCategory(category);
      expect(recount?.after).toMatchObject({ playable: true, playableCount: counts.playableCount });
      await eventually(() => offered(category), 10_000);
    } finally {
      await server.db.repos.appConfig.setCatalog(original, new Date());
    }
  });
});

describe("Missbrauchsbremse (Tagesbudget der Schutzautomatik)", () => {
  it("drei Gäste einer Lobby melden jede Frage einer Kategorie → höchstens das Budget, der Rest bleibt im Pool", async () => {
    const category = "musik-hits";
    const ids = await unverifiedQuestions(category, 8);
    const since = new Date(Date.now() - AUTO_RETIRE_BUDGET.windowMs);
    const already = await server.db.repos.questions.countAutoRetiredSince(since, category);
    const suppressedBefore = await metricValue(server.app.services.metrics, AUTO_RETIRE_SUPPRESSED_METRIC, {
      reason: "reports",
    });
    const trio = [randomUUID(), randomUUID(), randomUUID()];
    for (const questionId of ids) {
      for (const guestId of trio) {
        expect(await runtime().feedback.report({ questionId, guestId, reason: "falsch", lobbyCode: "ABC234" })).toBe(
          "created",
        );
      }
    }
    expect(await server.db.repos.questions.countAutoRetiredSince(since, category)).toBe(AUTO_RETIRE_BUDGET.perCategory);
    const kept = (await Promise.all(ids.map(question))).filter((doc) => doc.status !== "retired");
    expect(kept).toHaveLength(ids.length - (AUTO_RETIRE_BUDGET.perCategory - already));
    for (const doc of kept) {
      expect(doc.autoRetired).toBeNull();
      expect(runtime().questions.hasQuestion(doc._id)).toBe(true);
    }
    expect(await metricValue(server.app.services.metrics, AUTO_RETIRE_SUPPRESSED_METRIC, { reason: "reports" })).toBe(
      suppressedBefore + kept.length,
    );
    // Die Kategorie bleibt spielbar; die zurückgehaltenen Fragen stehen mit ihren Meldungen in der Prüf-Queue.
    await eventually(() => offered(category), 10_000);
    const reporters = await Promise.all(
      kept.map((doc) => server.db.repos.reports.countDistinctReporters(doc._id, since)),
    );
    expect(reporters.every((count) => count === 3)).toBe(true);
  });
});
