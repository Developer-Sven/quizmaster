/**
 * Schutzautomatik und Live-Zähler im laufenden Server (docs/08 §5) gegen die Test-DB:
 *
 * - Ende-zu-Ende: drei Mitspielende EINER Lobby melden dieselbe Frage über `question:report` – eine Quelle
 *   (ADR-058), die Frage bleibt; Meldungen und Bewertungen speichern HMAC-IP-Schlüssel und Lobby-Code. Zwei weitere
 *   unabhängige Quellen → DB-Status `retired` + `autoRetired`, der questions-Watcher nimmt sie live aus dem Pool,
 *   Metrik `qm_questions_auto_retired_total`.
 * - Schwellen: unabhängige Quellen (eigene IP und eigene Lobby, ADR-058), nur „falsch/veraltet/mehrdeutig“,
 *   7-Tage-Fenster; Bewertungsquote < 30 % bei ≥ 20 Bewertungen (genau 30 % bleibt), Daumen-runter aus ≥ 3
 *   unabhängigen Quellen.
 * - Idempotenz/Race: parallele Meldungen ziehen genau einmal zurück.
 * - Bezugszeit: Nach einer Wiederherstellung zählen alte Meldungen nicht erneut.
 * - Live-Zähler: Fällt eine Kategorie unter `appConfig.catalog.minPlayable`, wird sie nicht mehr angeboten
 *   (Kategorien-Watcher); nach der Wiederherstellung wieder.
 * - Missbrauchsbremse: Dieselben drei unabhängigen Gäste melden jede Frage einer Kategorie → höchstens das
 *   Tagesbudget je Kategorie wird zurückgezogen, der Rest bleibt im Pool (Metrik
 *   `qm_questions_auto_retire_suppressed_total`).
 *
 * Eigener Port-Bereich 4530–4539.
 */
import { randomUUID } from "node:crypto";
import { AUTO_RETIRE_BUDGET } from "@quizmaster/db";
import { findShownQuestion } from "@quizmaster/game-engine";
import { LOBBY_CODE_ALPHABET, type ReportReason } from "@quizmaster/shared";
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

/** Port-Bereich dieser Suite (Schutzautomatik). */
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

/** Gültiger Lobby-Code zu einer Zahl (Alphabet ohne I, L, O, 0, 1). */
function lobbyCodeFor(n: number): string {
  let code = "";
  let rest = n;
  for (let index = 0; index < 6; index++) {
    code = `${LOBBY_CODE_ALPHABET[rest % LOBBY_CODE_ALPHABET.length] ?? "A"}${code}`;
    rest = Math.floor(rest / LOBBY_CODE_ALPHABET.length);
  }
  return code;
}

const ipKeyOf = (n: number) => n.toString(16).padStart(32, "0");

let origins = 0;
/** Eigene IP und eigene Lobby: eine unabhängige Quelle (ADR-058). */
function independentOrigin(): { ipKey: string; lobbyCode: string } {
  origins += 1;
  return { ipKey: ipKeyOf(100_000 + origins), lobbyCode: lobbyCodeFor(100_000 + origins) };
}

function report(
  questionId: string,
  reason: ReportReason = "falsch",
  guestId: string = randomUUID(),
  origin = independentOrigin(),
) {
  return runtime().feedback.report({ questionId, guestId, reason, ...origin });
}

function rate(questionId: string, value: 1 | -1, origin: { ipKey: string; lobbyCode: string } = independentOrigin()) {
  return runtime().feedback.rate(questionId, randomUUID(), value, origin);
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
  it("drei Mitspielende einer Lobby sind eine Quelle; zwei weitere unabhängige → retired, live aus dem Pool", async () => {
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
    for (const [index, client] of [host, ben, cleo].entries()) {
      expect(
        await client.emit("question:report", { questionId: instanceId, reason: reasons[index] ?? "falsch" }),
      ).toEqual({ ok: true, data: null });
    }
    // Drei Mitspielende EINER Lobby sind eine Quelle (ADR-058): Die Frage bleibt, die Meldungen stehen in der Queue.
    expect((await question(dbId)).status).not.toBe("retired");
    expect(runtime().questions.hasQuestion(dbId)).toBe(true);
    // Gespeichert mit Herkunft: je Person ihr HMAC-IP-Schlüssel (eigene Test-IPs), dieselbe Lobby – nie die IP.
    const stored = await server.db.collections.questionReports.find({ questionId: dbId }).toArray();
    expect(stored).toHaveLength(3);
    expect(new Set(stored.map((doc) => doc.lobbyCode))).toEqual(new Set([code]));
    expect(new Set(stored.map((doc) => doc.ipKey)).size).toBe(3);
    for (const doc of stored) {
      expect(doc.ipKey).toMatch(/^[0-9a-f]{32}$/);
      expect(doc.ipKey).not.toContain(host.ip);
    }
    expect(await ben.emit("question:rate", { questionId: instanceId, value: -1 })).toEqual({ ok: true, data: null });
    const rating = await server.db.collections.questionRatings.findOne({ questionId: dbId });
    expect(rating).toMatchObject({ value: -1, lobbyCode: code });
    expect(rating?.ipKey).toBe(stored.find((doc) => doc.reason === "veraltet")?.ipKey);

    // Zwei weitere, unabhängige Quellen (andere IP, andere Lobby).
    expect(await report(dbId, "falsch")).toBe("created");
    expect((await question(dbId)).status).not.toBe("retired");
    expect(await report(dbId, "veraltet")).toBe("created");
    // Die Prüfung läuft vor dem Ergebnis: Die Frage ist schon zurückgezogen …
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

  it("zählt nur unabhängige Quellen mit „falsch/veraltet/mehrdeutig“ in den letzten 7 Tagen", async () => {
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
    expect(await report(questionId, "veraltet", guest)).toBe("duplicate"); // dieselbe Person meldet einmal
    expect(await report(questionId, "tippfehler")).toBe("created"); // Grund zählt nicht
    expect(await report(questionId, "unpassend")).toBe("created");
    expect(await report(questionId, "mehrdeutig")).toBe("created"); // zweiter Gast im Fenster
    expect((await question(questionId)).status).toBe("unverified");
    expect(runtime().questions.hasQuestion(questionId)).toBe(true);

    expect(await report(questionId, "veraltet")).toBe("created"); // dritte Quelle → zurückgezogen
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

describe("Unabhängige Quellen (ADR-058)", () => {
  it("eine Person mit Sessions in mehreren Lobbys oder eine Gruppe in einer Lobby zieht nichts allein zurück", async () => {
    const [questionId = ""] = await unverifiedQuestions("zeugen-der-zeit", 1);
    // Fünf Sessions hinter EINER IP in fünf Lobbys, dazu fünf Personen mit eigenen IPs in EINER Lobby.
    for (let index = 0; index < 5; index++) {
      expect(
        await report(questionId, "falsch", randomUUID(), { ipKey: "e".repeat(32), lobbyCode: lobbyCodeFor(index) }),
      ).toBe("created");
      expect(
        await report(questionId, "falsch", randomUUID(), { ipKey: ipKeyOf(9_000 + index), lobbyCode: "HJK234" }),
      ).toBe("created");
    }
    // Zehn Meldungen, aber zwei Quellen: bleibt im Pool (Prüf-Queue).
    expect(await question(questionId)).toMatchObject({ status: "unverified", autoRetired: null });
    const since = new Date(Date.now() - DAY_MS);
    expect(await server.db.repos.reports.countIndependentReporters(questionId, since)).toBe(2);
    expect(runtime().questions.hasQuestion(questionId)).toBe(true);
  });

  it("24 Daumen-runter aus zwei Quellen ziehen nicht zurück, die dritte unabhängige schon", async () => {
    const [questionId = ""] = await unverifiedQuestions("draussen-im-gruenen", 1);
    for (let index = 0; index < 12; index++)
      await rate(questionId, -1, { ipKey: ipKeyOf(9_100 + index), lobbyCode: "DEF234" });
    for (let index = 0; index < 12; index++) {
      await rate(questionId, -1, { ipKey: "d".repeat(32), lobbyCode: lobbyCodeFor(9_200 + index) });
    }
    // Quote 0 % bei 24 Bewertungen – aber nur zwei unabhängige Quellen.
    expect(await question(questionId)).toMatchObject({ status: "unverified", autoRetired: null });
    expect(await server.db.repos.ratings.dislikeSources(questionId, new Date(0))).toBe(2);
    await rate(questionId, -1);
    expect(await question(questionId)).toMatchObject({ status: "retired", autoRetired: { reason: "rating" } });
    await eventually(() => !runtime().questions.hasQuestion(questionId), 10_000);
  });
});

describe("Datensparsamkeit (ADR-058)", () => {
  it("die laufende App entfernt den IP-Schlüssel nach 30 Tagen, Meldung und Lobby-Code bleiben", async () => {
    const [questionId = ""] = await unverifiedQuestions("glaube-religion", 1);
    const old = new Date(Date.now() - 31 * DAY_MS);
    const { ipKey, lobbyCode } = independentOrigin();
    await server.db.collections.questionReports.insertOne({
      _id: "origin-retention-old",
      questionId,
      reason: "tippfehler",
      guestId: randomUUID(),
      lobbyCode,
      ipKey,
      status: "open",
      createdAt: old,
      expiresAt: new Date(old.getTime() + 365 * DAY_MS),
    });
    const result = await runtime().originRetention.runOnce();
    expect(result.reports).toBeGreaterThanOrEqual(1);
    const doc = await server.db.collections.questionReports.findOne({ _id: "origin-retention-old" });
    expect(doc).toMatchObject({ lobbyCode, status: "open" });
    expect(doc).not.toHaveProperty("ipKey");
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
  it("drei unabhängige Gäste melden jede Frage einer Kategorie → höchstens das Budget, der Rest bleibt im Pool", async () => {
    const category = "musik-hits";
    const ids = await unverifiedQuestions(category, 8);
    const since = new Date(Date.now() - AUTO_RETIRE_BUDGET.windowMs);
    const already = await server.db.repos.questions.countAutoRetiredSince(since, category);
    const suppressedBefore = await metricValue(server.app.services.metrics, AUTO_RETIRE_SUPPRESSED_METRIC, {
      reason: "reports",
    });
    const trio = [randomUUID(), randomUUID(), randomUUID()].map((guestId) => ({
      guestId,
      origin: independentOrigin(),
    }));
    for (const questionId of ids) {
      for (const { guestId, origin } of trio) {
        expect(await report(questionId, "falsch", guestId, origin)).toBe("created");
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
      kept.map((doc) => server.db.repos.reports.countIndependentReporters(doc._id, since)),
    );
    expect(reporters.every((count) => count === 3)).toBe(true);
  });
});
