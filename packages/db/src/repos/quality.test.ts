/**
 * Fragenqualität im Betrieb (docs/08 §5) auf Repository-Ebene: atomare Bewertungen (Zähler-Konsistenz auch bei
 * parallelen Änderungen), Zählfenster der Schutzautomatik, Prüf-Queue ohne guestIds, Wiederherstellung,
 * Live-Zähler der Kategorien, Kalibrierungsgrenzen – und `explain()` für jede neue Abfrage (IXSCAN, kein
 * COLLSCAN; docs/07 §MongoDB).
 */
import { randomUUID } from "node:crypto";
import type { RatingValue } from "@quizmaster/shared";
import type { CategoryDoc, QuestionReportDoc } from "@quizmaster/shared/documents";
import type { Document } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sampleQuestion } from "../test-support.ts";
import { createTestDatabase, type TestDatabase } from "../testing/index.ts";
import {
  AUTO_RETIRE_BUDGET,
  AUTO_RETIRE_RATING,
  AUTO_RETIRE_REPORTS,
  buildReviewQueue,
  CALIBRATION,
  calibrateQuestion,
  createRepositories,
  difficultyForHitRate,
  hitRate,
  isRatingRetireDue,
  isReportRetireDue,
  needsHitRateReview,
  RATING_WATCH,
  type Repositories,
  ratingQuote,
  recountCategory,
  reportWindowStart,
} from "./index.ts";

let t: TestDatabase;
let repos: Repositories;
const DAY_MS = 24 * 60 * 60 * 1_000;
// Relativ zur Laufzeit: Mit einem festen Datum wären Meldungen und Bewertungen nach Ablauf ihrer TTL (365 Tage) fällig,
// und der TTL-Monitor löschte sie mitten im Test.
const now = new Date();
const PRIMARY = { readPreference: "primary" } as const;

beforeAll(async () => {
  t = await createTestDatabase({ ensureIndexes: true });
  repos = createRepositories(t.client, t.collections);
});

afterAll(async () => {
  await t?.cleanup();
});

/** Stufen und Indizes nur der Gewinnerpläne eines explain()-Ergebnisses (ohne verworfene Pläne). */
function winningPlan(explain: Document): { stages: string[]; indexes: string[] } {
  const stages: string[] = [];
  const indexes: string[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.stage === "string") stages.push(record.stage);
    if (typeof record.indexName === "string") indexes.push(record.indexName);
    for (const [key, value] of Object.entries(record)) {
      if (key !== "rejectedPlans") collect(value);
    }
  };
  const find = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) find(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "winningPlan") collect(value);
      else if (key !== "rejectedPlans") find(value);
    }
  };
  find(explain);
  return { stages, indexes };
}

function expectIndexScan(explain: Document, index: string): void {
  const plan = winningPlan(explain);
  expect(plan.stages, JSON.stringify(plan)).not.toContain("COLLSCAN");
  expect(plan.indexes, JSON.stringify(plan)).toContain(index);
}

function report(questionId: string, overrides: Partial<QuestionReportDoc> = {}): QuestionReportDoc {
  const createdAt = overrides.createdAt ?? now;
  return {
    _id: randomUUID(),
    questionId,
    reason: "falsch",
    guestId: randomUUID(),
    lobbyCode: "ABC234",
    status: "open",
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 365 * DAY_MS),
    ...overrides,
  };
}

function category(id: string, overrides: Partial<CategoryDoc> = {}): CategoryDoc {
  return {
    _id: id,
    name: id,
    icon: "book-open",
    color: "#EBB447",
    order: 1,
    description: "d",
    scope: "s",
    notScope: "n",
    active: true,
    playableCount: 0,
    approvedCount: 0,
    playable: false,
    topics: [],
    updatedAt: now,
    ...overrides,
  };
}

describe("Testdokumente", () => {
  it("sind beim Lauf nicht abgelaufen – sonst löscht der TTL-Monitor (alle 60 s) sie mitten im Test", () => {
    expect(report("kf-ttl00001").expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("Schwellen und Regeln (docs/08 §5)", () => {
  it("Meldungen: ≥ 3 verschiedene Gäste, Fenster 7 Tage, frühestens ab der letzten Änderung", () => {
    expect(AUTO_RETIRE_REPORTS).toMatchObject({ minReporters: 3, windowMs: 7 * DAY_MS });
    expect([...AUTO_RETIRE_REPORTS.reasons].sort()).toEqual(["falsch", "mehrdeutig", "veraltet"]);
    expect(isReportRetireDue(2)).toBe(false);
    expect(isReportRetireDue(3)).toBe(true);
    expect(reportWindowStart(now, null)).toEqual(new Date(now.getTime() - 7 * DAY_MS));
    expect(reportWindowStart(now, new Date(now.getTime() - 30 * DAY_MS))).toEqual(new Date(now.getTime() - 7 * DAY_MS));
    const changed = new Date(now.getTime() - DAY_MS);
    expect(reportWindowStart(now, changed)).toEqual(changed);
  });

  it("Bewertungen: Quote < 30 % bei ≥ 20 Bewertungen (Grenzen exakt)", () => {
    expect(AUTO_RETIRE_RATING).toEqual({ minRatings: 20, belowPercent: 30 });
    expect(isRatingRetireDue({ likes: 5, dislikes: 14 })).toBe(false); // 19 Bewertungen
    expect(isRatingRetireDue({ likes: 5, dislikes: 15 })).toBe(true); // 25 %
    expect(isRatingRetireDue({ likes: 6, dislikes: 14 })).toBe(false); // genau 30 %
    expect(isRatingRetireDue({ likes: 0, dislikes: 20 })).toBe(true);
    expect(isRatingRetireDue({ likes: 29, dislikes: 71 })).toBe(true); // 29 %
    expect(ratingQuote({ likes: 0, dislikes: 0 })).toBeNull();
    expect(ratingQuote({ likes: 1, dislikes: 3 })).toBe(0.25);
  });

  it("Kalibrierung: 1 > 85 %, 2 65–85 %, 3 45–65 %, 4 25–45 %, 5 < 25 %; < 10 % → Prüf-Queue", () => {
    expect(CALIBRATION).toEqual({ minShown: 30, reviewBelowPercent: 10 });
    const cases: Array<[number, number, number]> = [
      [100, 100, 1],
      [100, 86, 1],
      [100, 85, 2], // genau 85 % gehört zu 2 (1 verlangt „mehr als 85 %“)
      [100, 65, 2],
      [100, 64, 3],
      [100, 45, 3],
      [100, 44, 4],
      [100, 25, 4],
      [100, 24, 5],
      [100, 0, 5],
      [40, 34, 2], // 85 %
      [40, 35, 1], // 87,5 %
      [7, 6, 1], // 85,7 % – ganzzahliger Vergleich ohne Rundungsfehler
      [20, 13, 2], // 65 %
      [20, 9, 3], // 45 %
      [20, 5, 4], // 25 %
    ];
    for (const [shown, correct, difficulty] of cases) {
      expect(difficultyForHitRate(shown, correct), `${correct}/${shown}`).toBe(difficulty);
    }
    expect(needsHitRateReview(30, 2)).toBe(true); // 6,7 %
    expect(needsHitRateReview(30, 3)).toBe(false); // genau 10 %
    expect(needsHitRateReview(29, 0)).toBe(false); // unter 30 Anzeigen nicht aussagekräftig
    expect(needsHitRateReview(10, 0, 10)).toBe(true);
    expect(hitRate(0, 0)).toBe(0);
    expect(hitRate(10, 12)).toBe(1); // Datenfehler: höchstens jede Anzeige
    const row = {
      _id: "co-calib001",
      category: "comics",
      topic: "grundlagen",
      difficulty: 3,
      status: "unverified",
      contentHash: "a".repeat(64),
      stats: { shown: 40, correct: 3 },
    } as const;
    expect(calibrateQuestion(row)).toMatchObject({ suggested: 5, review: true, change: false, rate: 0.075 });
    expect(calibrateQuestion({ ...row, stats: { shown: 40, correct: 36 } })).toMatchObject({
      current: 3,
      suggested: 1,
      review: false,
      change: true,
    });
    expect(calibrateQuestion({ ...row, stats: { shown: 40, correct: 20 } })).toMatchObject({
      suggested: 3,
      change: false,
    });
  });
});

describe("ratings.rate – atomar (Transaktion)", () => {
  beforeAll(async () => {
    await t.collections.questions.insertMany([
      sampleQuestion("co-rate0001"),
      sampleQuestion("co-rate0002"),
      sampleQuestion("co-rate0003"),
      sampleQuestion("co-rate0004"),
    ]);
  });

  it("Übergänge null → 1 → −1 → −1 und Stand der Frage aus derselben Transaktion", async () => {
    const guest = randomUUID();
    const first = await repos.ratings.rate("co-rate0001", guest, 1, now);
    expect(first).toMatchObject({ previous: null, current: 1, delta: { likes: 1, dislikes: 0 } });
    expect(first.question).toMatchObject({ _id: "co-rate0001", category: "comics", status: "unverified" });
    expect(first.question?.stats).toMatchObject({ likes: 1, dislikes: 0 });
    const flipped = await repos.ratings.rate("co-rate0001", guest, -1, now);
    expect(flipped).toMatchObject({ previous: 1, current: -1, delta: { likes: -1, dislikes: 1 } });
    expect(flipped.question?.stats).toMatchObject({ likes: 0, dislikes: 1 });
    const same = await repos.ratings.rate("co-rate0001", guest, -1, now);
    expect(same).toMatchObject({ previous: -1, delta: { likes: 0, dislikes: 0 } });
    expect(same.question?.stats).toMatchObject({ likes: 0, dislikes: 1 });
    expect(await t.collections.questionRatings.countDocuments({ questionId: "co-rate0001" })).toBe(1);
  });

  it("parallele Bewertungen und Wechsel derselben Person: Zähler = Bewertungen, kein Validator-Fehler", async () => {
    const guests = Array.from({ length: 6 }, () => randomUUID());
    const values: RatingValue[] = [1, -1];
    for (let round = 0; round < 3; round++) {
      // Je Runde jede Person zweimal gleichzeitig mit entgegengesetzten Werten (Doppelklick in zwei Tabs).
      const results = await Promise.allSettled(
        guests.flatMap((guest, index) => [
          repos.ratings.rate("co-rate0002", guest, values[(index + round) % 2] ?? 1, now),
          repos.ratings.rate("co-rate0002", guest, values[(index + round + 1) % 2] ?? -1, now),
        ]),
      );
      const failures = results.filter((result) => result.status === "rejected");
      expect(failures, JSON.stringify(failures)).toEqual([]);
    }
    const truth = await repos.ratings.summary("co-rate0002");
    expect(truth.likes + truth.dislikes).toBe(guests.length);
    const stored = await t.collections.questions.findOne({ _id: "co-rate0002" });
    expect({ likes: stored?.stats.likes, dislikes: stored?.stats.dislikes }).toEqual(truth);
  });

  it("ein älterer Zählerfehler (likes = 0 trotz Like) blockiert keine Änderung (Untergrenze 0)", async () => {
    const guest = randomUUID();
    await repos.ratings.rate("co-rate0003", guest, 1, now);
    await t.collections.questions.updateOne({ _id: "co-rate0003" }, { $set: { "stats.likes": 0 } });
    const change = await repos.ratings.rate("co-rate0003", guest, -1, now);
    expect(change.question?.stats).toMatchObject({ likes: 0, dislikes: 1 });
  });

  it("Bewertung ohne Frage in der DB: gespeichert, Stand null", async () => {
    const change = await repos.ratings.rate("co-missing9", randomUUID(), 1, now);
    expect(change).toMatchObject({ previous: null, current: 1, question: null });
  });

  it("summary seit einem Zeitpunkt, summaries je Frage, countsByQuestion ab Mindestzahl", async () => {
    const before = new Date(now.getTime() - 10 * DAY_MS);
    for (let index = 0; index < 4; index++) await repos.ratings.rate("co-rate0004", randomUUID(), -1, before);
    await repos.ratings.rate("co-rate0004", randomUUID(), 1, now);
    expect(await repos.ratings.summary("co-rate0004")).toEqual({ likes: 1, dislikes: 4 });
    expect(await repos.ratings.summary("co-rate0004", new Date(now.getTime() - DAY_MS))).toEqual({
      likes: 1,
      dislikes: 0,
    });
    const many = await repos.ratings.summaries(
      [
        { questionId: "co-rate0004", since: new Date(now.getTime() - DAY_MS) },
        { questionId: "co-rate0001" },
        { questionId: "co-norate01" },
      ],
      PRIMARY,
    );
    expect(Object.fromEntries(many)).toEqual({
      "co-rate0004": { likes: 1, dislikes: 0 },
      "co-rate0001": { likes: 0, dislikes: 1 },
    });
    const counts = await repos.ratings.countsByQuestion({ ...PRIMARY, minRatings: 5 });
    expect(counts.map((row) => row.questionId)).toEqual(expect.arrayContaining(["co-rate0002", "co-rate0004"]));
    expect(counts.find((row) => row.questionId === "co-rate0004")).toEqual({
      questionId: "co-rate0004",
      likes: 1,
      dislikes: 4,
    });
    expect(counts.map((row) => row.questionId)).not.toContain("co-rate0001");
  });
});

describe("questionReports – Schutzautomatik-Zählung und Prüf-Queue", () => {
  beforeAll(async () => {
    await t.collections.questions.insertMany([sampleQuestion("co-rep00001"), sampleQuestion("co-rep00002")]);
  });

  it("zählt nur offene Meldungen der Gründe, verschiedene Gäste, im Fenster", async () => {
    const [a, b, c, d] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await t.collections.questionReports.insertMany([
      report("co-rep00001", { guestId: a, reason: "falsch" }),
      report("co-rep00001", { guestId: a, reason: "veraltet" }), // gleiche Person zählt einmal
      report("co-rep00001", { guestId: b, reason: "tippfehler" }), // Grund zählt nicht
      report("co-rep00001", { guestId: c, reason: "mehrdeutig", status: "dismissed" }), // verworfen
      report("co-rep00001", { guestId: d, reason: "falsch", createdAt: new Date(now.getTime() - 8 * DAY_MS) }), // alt
    ]);
    const since = reportWindowStart(now, null);
    expect(await repos.reports.countDistinctReporters("co-rep00001", since)).toBe(1);
    expect(await repos.reports.countDistinctReporters("co-rep00001", since, ["falsch", "tippfehler"])).toBe(2);
    expect(await repos.reports.countDistinctReporters("co-rep00001", new Date(now.getTime() - 9 * DAY_MS))).toBe(2);
  });

  it("gruppiert offene Meldungen je Frage – Gründe, Anzahl, Zeitraum, ohne guestIds", async () => {
    const guests = [randomUUID(), randomUUID()];
    await t.collections.questionReports.insertMany([
      report("co-rep00002", { guestId: guests[0], reason: "falsch", createdAt: new Date(now.getTime() - DAY_MS) }),
      report("co-rep00002", { guestId: guests[1], reason: "unpassend", createdAt: now }),
      report("co-rep00002", { guestId: guests[1], reason: "falsch", status: "resolved" }),
    ]);
    const { groups, truncated } = await repos.reports.summarizeOpen({ ...PRIMARY });
    expect(truncated).toBe(false);
    const group = groups.find((entry) => entry.questionId === "co-rep00002");
    expect(group).toMatchObject({
      open: 2,
      reporters: 2,
      severeReporters: 1,
      byReason: { falsch: 1, unpassend: 1 },
      firstAt: new Date(now.getTime() - DAY_MS),
      lastAt: now,
    });
    expect(group?.reportIds).toHaveLength(2);
    const serialized = JSON.stringify(groups);
    for (const guest of guests) expect(serialized).not.toContain(guest);
    expect(serialized).not.toContain("guestId");
    expect(serialized).not.toContain("ABC234");
  });

  it("resolveOpen: einzelne Meldung oder alle offenen einer Frage", async () => {
    const [first, second, third] = [report("co-rep00003"), report("co-rep00003"), report("co-rep00003")];
    await t.collections.questionReports.insertMany([first, second, third]);
    expect(await repos.reports.resolveOpen({ reportId: first._id }, "dismissed")).toBe(1);
    expect(await repos.reports.resolveOpen({ reportId: first._id }, "resolved")).toBe(0); // nicht mehr offen
    expect(await repos.reports.resolveOpen({ questionId: "co-rep00003" }, "resolved")).toBe(2);
    const statuses = await t.collections.questionReports.find({ questionId: "co-rep00003" }).toArray();
    expect(statuses.map((doc) => doc.status).sort()).toEqual(["dismissed", "resolved", "resolved"]);
    await expect(
      repos.reports.resolveOpen({ questionId: { $ne: null } as unknown as string }, "resolved"),
    ).rejects.toThrow();
    await expect(repos.reports.resolveOpen({ reportId: "x" }, "open" as never)).rejects.toThrow();
  });
});

describe("questions – Schutzautomatik, Wiederherstellung, Live-Zähler", () => {
  const changedAt = new Date(now.getTime() - 11 * DAY_MS);

  beforeAll(async () => {
    await t.collections.questions.insertMany([
      sampleQuestion("kf-quali001", { category: "kinofilme", updatedAt: changedAt }),
      sampleQuestion("kf-quali002", { category: "kinofilme", status: "approved", source: "https://example.org" }),
      sampleQuestion("kf-quali003", { category: "kinofilme", contentHash: "b".repeat(64) }),
      sampleQuestion("kf-quali004", { category: "kinofilme", status: "retired" }),
    ]);
    await t.collections.categories.insertOne(category("kinofilme", { playable: true, playableCount: 3 }));
  });

  it("autoRetire mit Guard: geänderte Frage bleibt, sonst genau einmal retired", async () => {
    const state = await repos.questions.findQualityState("kf-quali001");
    expect(state).toMatchObject({
      _id: "kf-quali001",
      category: "kinofilme",
      status: "unverified",
      updatedAt: changedAt,
    });
    expect(state).not.toHaveProperty("prompt");
    const at = new Date(now.getTime() + 1_000);
    expect(await repos.questions.autoRetire("kf-quali001", "reports", at, { updatedAt: new Date(0) })).toBe(false);
    expect(await repos.questions.autoRetire("kf-quali001", "reports", at, { updatedAt: changedAt })).toBe(true);
    expect(await repos.questions.autoRetire("kf-quali001", "rating", at, { updatedAt: at })).toBe(false);
    expect(await repos.questions.findQualityState("kf-quali001")).toMatchObject({
      status: "retired",
      autoRetired: { reason: "reports", at },
      updatedAt: at,
    });
    // Im Repo retired (ohne Schutzautomatik) → nie als autoRetired markieren.
    expect(await repos.questions.autoRetire("kf-quali004", "reports", at)).toBe(false);
    expect((await repos.questions.findQualityState("kf-quali004"))?.autoRetired).toBeNull();
  });

  it("restoreAutoRetired nur bei passendem Inhalt und gesetztem autoRetired", async () => {
    const at = new Date(now.getTime() + 2_000);
    await repos.questions.autoRetire("kf-quali003", "rating", at);
    expect(
      await repos.questions.restoreAutoRetired(
        "kf-quali003",
        { status: "unverified", contentHash: "0".repeat(64) },
        at,
      ),
    ).toBe(false);
    expect(
      await repos.questions.restoreAutoRetired(
        "kf-quali003",
        { status: "unverified", contentHash: "b".repeat(64) },
        at,
      ),
    ).toBe(true);
    expect(await repos.questions.findQualityState("kf-quali003")).toMatchObject({
      status: "unverified",
      autoRetired: null,
      updatedAt: at,
    });
    expect(
      await repos.questions.restoreAutoRetired(
        "kf-quali003",
        { status: "unverified", contentHash: "b".repeat(64) },
        at,
      ),
    ).toBe(false);
    expect(
      await repos.questions.restoreAutoRetired(
        "kf-quali004",
        { status: "unverified", contentHash: "0".repeat(64) },
        at,
      ),
    ).toBe(false);
    await expect(
      repos.questions.restoreAutoRetired(
        "kf-quali003",
        { status: "retired" as never, contentHash: "b".repeat(64) },
        at,
      ),
    ).rejects.toThrow();
  });

  it("countPlayable + recountCategory: Zähler und playable aus minPlayable und Pool", async () => {
    expect(await repos.questions.countPlayable("kinofilme")).toEqual({ playableCount: 2, approvedCount: 1 });
    const recount = await recountCategory(repos, "kinofilme", { minPlayable: 3, pool: "all" }, now);
    expect(recount).toEqual({
      categoryId: "kinofilme",
      before: { active: true, playable: true, playableCount: 3, approvedCount: 0 },
      after: { active: true, playable: false, playableCount: 2, approvedCount: 1 },
    });
    expect(await t.collections.categories.findOne({ _id: "kinofilme" })).toMatchObject({
      playable: false,
      playableCount: 2,
      approvedCount: 1,
      updatedAt: now,
    });
    const again = await recountCategory(repos, "kinofilme", { minPlayable: 2, pool: "all" }, now);
    expect(again?.after.playable).toBe(true);
    const approvedOnly = await recountCategory(repos, "kinofilme", { minPlayable: 2, pool: "approved" }, now);
    expect(approvedOnly?.after.playable).toBe(false);
    await t.collections.categories.updateOne({ _id: "kinofilme" }, { $set: { active: false } });
    const inactive = await recountCategory(repos, "kinofilme", { minPlayable: 1, pool: "all" }, now);
    expect(inactive?.after).toMatchObject({ active: false, playable: false });
    expect(await recountCategory(repos, "comics-fehlt", { minPlayable: 1, pool: "all" }, now)).toBeNull();
    await expect(
      repos.categories.applyCounts(
        "kinofilme",
        { playableCount: -1, approvedCount: 0 },
        { minPlayable: 1, pool: "all" },
        now,
      ),
    ).rejects.toThrow();
  });

  it("calibrationStats: nur spielbare Fragen ab minShown, standardmäßig secondaryPreferred", async () => {
    await t.collections.questions.insertMany([
      sampleQuestion("wt-calib001", {
        category: "wunder-der-technik",
        stats: { shown: 30, correct: 2, likes: 0, dislikes: 0, reports: 0 },
      }),
      sampleQuestion("wt-calib002", {
        category: "wunder-der-technik",
        stats: { shown: 29, correct: 2, likes: 0, dislikes: 0, reports: 0 },
      }),
      sampleQuestion("wt-calib003", {
        category: "wunder-der-technik",
        status: "retired",
        stats: { shown: 90, correct: 1, likes: 0, dislikes: 0, reports: 0 },
      }),
    ]);
    const rows = await repos.questions.calibrationStats({ ...PRIMARY, minShown: 30 });
    expect(rows.map((row) => row._id)).toContain("wt-calib001");
    expect(rows.map((row) => row._id)).not.toContain("wt-calib002");
    expect(rows.map((row) => row._id)).not.toContain("wt-calib003");
    expect(rows.find((row) => row._id === "wt-calib001")).toEqual({
      _id: "wt-calib001",
      category: "wunder-der-technik",
      topic: "grundlagen",
      difficulty: 2,
      status: "unverified",
      contentHash: "0".repeat(64),
      stats: { shown: 30, correct: 2 },
    });
    const spy = vi.spyOn(t.collections.questions, "find");
    try {
      await repos.questions.calibrationStats({ minShown: 30 });
      await repos.questions.listAutoRetired();
      await repos.questions.findForReview(["wt-calib001"]);
      for (const call of spy.mock.calls) expect(call[1]).toMatchObject({ readPreference: "secondaryPreferred" });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("questions – Missbrauchsbremse und Massen-Wiederherstellung der Schutzautomatik", () => {
  // Zwei Stunden nach den übrigen Tests dieser Datei: deren zurückgezogene Fragen sind älter als alle hier.
  const base = new Date(now.getTime() + 2 * 60 * 60_000);
  const at = (minutesAgo: number) => new Date(base.getTime() - minutesAgo * 60_000);
  const retired = (id: string, category: string, reason: "reports" | "rating", when: Date) =>
    sampleQuestion(id, { category, status: "retired", autoRetired: { reason, at: when }, updatedAt: when });

  beforeAll(async () => {
    // Neueste zuerst eingefügt: ein Limit VOR dem Sortieren lieferte die ältesten.
    await t.collections.questions.insertMany([
      retired("mh-brems001", "musik-hits", "reports", at(1)),
      retired("mh-brems002", "musik-hits", "rating", at(30)),
      retired("mh-brems003", "musik-hits", "reports", at(60 * 23)),
      retired("mh-brems004", "musik-hits", "reports", at(60 * 25)), // außerhalb von 24 h
      retired("il-brems001", "im-labor", "reports", at(5)),
      sampleQuestion("il-brems002", { category: "im-labor", status: "retired" }), // im Repo retired, nicht automatisch
    ]);
  });

  it("countAutoRetiredSince: automatische Rückzüge im Fenster je Kategorie und insgesamt", async () => {
    const since = new Date(base.getTime() - AUTO_RETIRE_BUDGET.windowMs);
    expect(await repos.questions.countAutoRetiredSince(since, "musik-hits")).toBe(3);
    expect(await repos.questions.countAutoRetiredSince(since, "im-labor")).toBe(1);
    expect(await repos.questions.countAutoRetiredSince(at(10))).toBe(2);
    expect(await repos.questions.countAutoRetiredSince(base, "musik-hits")).toBe(0);
    expect(AUTO_RETIRE_BUDGET).toEqual({ windowMs: DAY_MS, perCategory: 5, total: 20 });
  });

  it("listAutoRetired: neueste zuerst VOR der Höchstzahl; Filter Zeitpunkt und Grund", async () => {
    const newest = await repos.questions.listAutoRetired({ ...PRIMARY, since: at(60 * 26), limit: 2 });
    expect(newest.questions.map((question) => question._id)).toEqual(["mh-brems001", "il-brems001"]);
    expect(newest.truncated).toBe(true);
    const since = await repos.questions.listAutoRetired({ ...PRIMARY, since: at(60 * 24) });
    expect(since.questions.map((question) => question._id).filter((id) => id.includes("brems"))).toEqual([
      "mh-brems001",
      "il-brems001",
      "mh-brems002",
      "mh-brems003",
    ]);
    expect(since.truncated).toBe(false);
    const rating = await repos.questions.listAutoRetired({ ...PRIMARY, since: at(60 * 24), reason: "rating" });
    expect(rating.questions.map((question) => question._id)).toEqual(["mh-brems002"]);
  });

  it("explain: Budget-Zählung über status_category_difficulty", async () => {
    expectIndexScan(
      await t.collections.questions
        .find({ status: "retired", category: "musik-hits", "autoRetired.at": { $gte: at(60) } })
        .explain("queryPlanner"),
      "status_category_difficulty",
    );
  });
});

describe("Prüf-Queue (buildReviewQueue)", () => {
  const guests = Array.from({ length: 4 }, () => randomUUID());

  beforeAll(async () => {
    const stats = (shown: number, correct: number) => ({ shown, correct, likes: 0, dislikes: 0, reports: 0 });
    await t.collections.questions.insertMany([
      sampleQuestion("mh-queue001", { category: "musik-hits", prompt: "Gemeldete Frage?" }),
      sampleQuestion("mh-queue002", {
        category: "musik-hits",
        status: "retired",
        autoRetired: { reason: "rating", at: new Date(now.getTime() - DAY_MS) },
      }),
      sampleQuestion("mh-queue003", { category: "musik-hits", updatedAt: new Date(now.getTime() - 5 * DAY_MS) }),
      sampleQuestion("mh-queue004", { category: "musik-hits", stats: stats(40, 2) }),
      sampleQuestion("mh-queue005", { category: "musik-hits" }),
    ]);
    await t.collections.questionReports.insertMany([
      report("mh-queue001", { guestId: guests[0], reason: "falsch" }),
      report("mh-queue001", { guestId: guests[1], reason: "veraltet" }),
      report("mh-queue001", { guestId: guests[2], reason: "tippfehler" }),
      report("mh-queue005", { guestId: guests[3], reason: "tippfehler" }),
    ]);
    // 12 Bewertungen seit der letzten Änderung, 3 × hoch (25 %), dazu 10 ältere Daumen hoch (zählen nicht).
    for (let index = 0; index < 12; index++) {
      await repos.ratings.rate("mh-queue003", randomUUID(), index < 3 ? 1 : -1, now);
    }
    for (let index = 0; index < 10; index++) {
      await repos.ratings.rate("mh-queue003", randomUUID(), 1, new Date(now.getTime() - 6 * DAY_MS));
    }
  });

  it("priorisiert: schwere Meldungen, zurückgezogen, leichte Meldungen, Bewertung, Trefferquote", async () => {
    const queue = await buildReviewQueue(repos, { now, ...PRIMARY });
    const ids = queue.items.map((item) => item.questionId).filter((id) => id.startsWith("mh-queue"));
    expect(ids).toEqual(["mh-queue001", "mh-queue002", "mh-queue005", "mh-queue003", "mh-queue004"]);
    const byId = new Map(queue.items.map((item) => [item.questionId, item]));
    expect(byId.get("mh-queue001")).toMatchObject({
      flags: ["reports"],
      tier: 0,
      prompt: "Gemeldete Frage?",
      reports: { open: 3, reporters: 3, severeReporters: 2, byReason: { falsch: 1, veraltet: 1, tippfehler: 1 } },
    });
    expect(byId.get("mh-queue002")).toMatchObject({ flags: ["auto_retired"], tier: 0, status: "retired" });
    expect(byId.get("mh-queue005")).toMatchObject({ flags: ["reports"], tier: 1 });
    expect(byId.get("mh-queue003")).toMatchObject({
      flags: ["low_rating"],
      tier: 2,
      ratingWindow: { likes: 3, dislikes: 9, quote: 0.25, since: new Date(now.getTime() - 5 * DAY_MS) },
    });
    expect(byId.get("mh-queue004")).toMatchObject({
      flags: ["low_hit_rate"],
      tier: 3,
      hitRate: { shown: 40, correct: 2, rate: 0.05 },
      prompt: "Testfrage mh-queue004?",
    });
    expect(queue.thresholds).toEqual({
      ratingWatch: { minRatings: RATING_WATCH.minRatings, belowPercent: RATING_WATCH.belowPercent },
      calibration: { minShown: 30, reviewBelowPercent: 10 },
    });
    expect(queue.totals.autoRetired).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(queue);
    for (const guest of guests) expect(serialized).not.toContain(guest);
    expect(serialized).not.toContain("guestId");
  });
});

describe("explain: neue Abfragen laufen über Indizes (IXSCAN, kein COLLSCAN)", () => {
  it("Schutzautomatik: Meldungen je Frage im Fenster → questionId_createdAt", async () => {
    const plan = await t.collections.questionReports
      .aggregate(
        [
          {
            $match: {
              questionId: "co-rep00001",
              createdAt: { $gte: now },
              reason: { $in: ["falsch", "veraltet", "mehrdeutig"] },
              status: "open",
            },
          },
          { $group: { _id: "$guestId" } },
          { $count: "reporters" },
        ],
        { hint: { questionId: 1, createdAt: -1 } },
      )
      .explain("queryPlanner");
    expectIndexScan(plan, "questionId_createdAt");
  });

  it("Prüf-Queue: offene Meldungen gruppiert → status_createdAt; Abschluss je Frage → questionId_createdAt", async () => {
    expectIndexScan(
      await t.collections.questionReports
        .aggregate([{ $match: { status: "open" } }, { $group: { _id: "$questionId", open: { $sum: 1 } } }])
        .explain("queryPlanner"),
      "status_createdAt",
    );
    expectIndexScan(
      await t.collections.questionReports
        .find({ questionId: "co-rep00003", status: "open" })
        .hint({ questionId: 1, createdAt: -1 })
        .explain("queryPlanner"),
      "questionId_createdAt",
    );
  });

  it("Bewertungen: Fenster je Frage, mehrere Fragen ($or), Kandidaten nach Frage → questionId", async () => {
    expectIndexScan(
      await t.collections.questionRatings
        .aggregate([
          { $match: { questionId: "co-rate0004", updatedAt: { $gte: now } } },
          { $group: { _id: null, likes: { $sum: 1 } } },
        ])
        .explain("queryPlanner"),
      "questionId",
    );
    expectIndexScan(
      await t.collections.questionRatings
        .aggregate([
          { $match: { $or: [{ questionId: "co-rate0004", updatedAt: { $gte: now } }, { questionId: "co-rate0001" }] } },
          { $group: { _id: "$questionId", likes: { $sum: 1 } } },
        ])
        .explain("queryPlanner"),
      "questionId",
    );
    expectIndexScan(
      await t.collections.questionRatings
        .aggregate([{ $sort: { questionId: 1 } }, { $group: { _id: "$questionId", total: { $sum: 1 } } }])
        .explain("queryPlanner"),
      "questionId",
    );
  });

  it("Fragen der Prüf-Queue per $in → _id_", async () => {
    expectIndexScan(
      await t.collections.questions.find({ _id: { $in: ["mh-queue001", "mh-queue002"] } }).explain("queryPlanner"),
      "_id_",
    );
  });

  it("Fragen: Zähler je Kategorie, zurückgezogene, Kalibrierung → status_category_difficulty", async () => {
    expectIndexScan(
      await t.collections.questions
        .aggregate([
          { $match: { status: { $in: ["unverified", "approved"] }, category: "kinofilme" } },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ])
        .explain("queryPlanner"),
      "status_category_difficulty",
    );
    expectIndexScan(
      await t.collections.questions.find({ status: "retired", autoRetired: { $ne: null } }).explain("queryPlanner"),
      "status_category_difficulty",
    );
    expectIndexScan(
      await t.collections.questions
        .find({ status: { $in: ["unverified", "approved"] }, "stats.shown": { $gte: 30 } })
        .explain("queryPlanner"),
      "status_category_difficulty",
    );
  });
});
