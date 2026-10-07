/**
 * Schutzautomatik und Live-Zähler (docs/08 §5) als Unit-Tests mit Fake-Repositories: Fehlerpfade (Feedback bleibt
 * gespeichert, Fehler werden geloggt und gezählt), Vorfilter ohne DB-Zugriff, genau ein Übergang bei parallelen
 * Prüfungen, Neuberechnung je Kategorie höchstens „eine laufende + eine folgende“, Logs ohne guestIds.
 */
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  AUTO_RETIRE_BUDGET,
  type CategoryRecount,
  type PlayableCounts,
  type QuestionQualityState,
  type RatingChange,
  type RatingSummary,
  type Repositories,
} from "@quizmaster/db";
import { defaultAppConfig } from "@quizmaster/shared/documents";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logger.ts";
import { createMetrics } from "../../src/metrics.ts";
import { createFeedbackService } from "../../src/services/feedback.ts";
import {
  AUTO_RETIRE_SUPPRESSED_METRIC,
  AUTO_RETIRED_METRIC,
  createQualityService,
  type QualityServiceDeps,
} from "../../src/services/quality.ts";
import { metricValue } from "../helpers/index.ts";

const now = new Date("2026-10-01T10:00:00Z");
/** Herkunft einer Bewertung, wo sie keine Rolle spielt (ADR-058). */
const ORIGIN = { ipKey: null, lobbyCode: null } as const;

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      callback();
    },
  });
  return { logger: createLogger({ level: "debug", destination }), lines };
}

function state(overrides: Partial<QuestionQualityState> = {}): QuestionQualityState {
  return {
    _id: "co-unit0001",
    category: "comics",
    status: "unverified",
    autoRetired: null,
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    stats: { shown: 0, correct: 0, likes: 0, dislikes: 0, reports: 0 },
    ...overrides,
  };
}

function recountResult(before: boolean, after: boolean, playableCount = 10): CategoryRecount {
  return {
    categoryId: "comics",
    before: { active: true, playable: before, playableCount: playableCount + 1, approvedCount: 1 },
    after: { active: true, playable: after, playableCount, approvedCount: 1 },
  };
}

interface FakeOptions {
  quality?: QuestionQualityState | null;
  reporters?: number | (() => Promise<number>);
  summary?: RatingSummary | (() => Promise<RatingSummary>);
  /** Unabhängige Quellen der Daumen-runter (Standard 3, ADR-058). */
  dislikeSources?: number;
  autoRetire?: () => Promise<boolean>;
  counts?: () => Promise<PlayableCounts>;
  applyCounts?: () => Promise<CategoryRecount | null>;
  minPlayable?: number;
  change?: RatingChange;
  /** Automatische Rückzüge im Budget-Fenster (Standard 0); `category` fehlt = insgesamt. */
  retiredSince?: (since: Date, category?: string) => Promise<number>;
}

/** Fake-Repositories mit Aufrufzählern (nur die Methoden, die Feedback und Schutzautomatik nutzen). */
function fakeRepos(options: FakeOptions = {}) {
  const calls = {
    summary: 0,
    autoRetire: 0,
    countPlayable: 0,
    applyCounts: 0,
    appConfig: 0,
    reporters: 0,
    dislikeSources: 0,
    rateOrigins: [] as unknown[],
    reportsCreated: [] as unknown[],
    retiredSince: [] as Array<{ since: Date; category: string | undefined }>,
  };
  const config = defaultAppConfig(now);
  const repos = {
    questions: {
      async findQualityState() {
        return options.quality === undefined ? state() : options.quality;
      },
      async incrementReports() {
        return options.quality === undefined ? state() : options.quality;
      },
      async autoRetire() {
        calls.autoRetire += 1;
        return options.autoRetire ? options.autoRetire() : true;
      },
      async countPlayable() {
        calls.countPlayable += 1;
        return options.counts ? options.counts() : { playableCount: 10, approvedCount: 1 };
      },
      async countAutoRetiredSince(since: Date, category?: string) {
        calls.retiredSince.push({ since, category });
        return options.retiredSince ? options.retiredSince(since, category) : 0;
      },
    },
    reports: {
      async create(report: unknown) {
        calls.reportsCreated.push(report);
        return {};
      },
      async findReportedQuestionIds() {
        return new Set<string>();
      },
      async countIndependentReporters() {
        calls.reporters += 1;
        const value = options.reporters ?? 0;
        return typeof value === "number" ? value : value();
      },
    },
    ratings: {
      async rate(_questionId: string, _guestId: string, _value: number, _now: Date, origin: unknown) {
        calls.rateOrigins.push(origin);
        return (
          options.change ?? {
            previous: null,
            current: -1,
            delta: { likes: 0, dislikes: 1 },
            question: state({ stats: { shown: 0, correct: 0, likes: 5, dislikes: 20, reports: 0 } }),
          }
        );
      },
      async summary() {
        calls.summary += 1;
        const value = options.summary ?? { likes: 10, dislikes: 10 };
        return typeof value === "function" ? value() : value;
      },
      async dislikeSources() {
        calls.dislikeSources += 1;
        return options.dislikeSources ?? 3;
      },
      async findByGuest() {
        return new Map();
      },
    },
    categories: {
      async applyCounts() {
        calls.applyCounts += 1;
        return options.applyCounts ? options.applyCounts() : recountResult(true, true);
      },
    },
    appConfig: {
      async get() {
        calls.appConfig += 1;
        return { ...config, catalog: { ...config.catalog, minPlayable: options.minPlayable ?? 3 } };
      },
    },
  };
  return { repos: repos as unknown as QualityServiceDeps["repos"] & Pick<Repositories, "ratings">, calls };
}

function setup(options: FakeOptions = {}, extra: Partial<Pick<QualityServiceDeps, "appConfig" | "pool">> = {}) {
  const { repos, calls } = fakeRepos(options);
  const { logger, lines } = capture();
  const metrics = createMetrics({ socketCount: () => 0 });
  const deps = { repos, clock: { now: () => now.getTime() }, logger, metrics, ...extra };
  return { quality: createQualityService(deps), feedback: createFeedbackService(deps), calls, lines, metrics };
}

describe("Schutzautomatik – Fehlerpfade", () => {
  it("ein DB-Fehler in der Prüfung bricht die Bewertung nicht ab (Log + Metrik)", async () => {
    const { feedback, lines, metrics } = setup({
      summary: () => Promise.reject(new Error("Netzwerk weg")),
    });
    const guestId = randomUUID();
    const change = await feedback.rate("co-unit0001", guestId, -1, ORIGIN);
    expect(change.current).toBe(-1);
    expect(lines.some((line) => line.includes("Schutzautomatik: Prüfung fehlgeschlagen"))).toBe(true);
    expect(await metricValue(metrics, "qm_mongo_errors_total", { operation: "quality_check" })).toBe(1);
    expect(lines.join("\n")).not.toContain(guestId);
  });

  it("ein Fehler der Prüfung nach einer Meldung lässt die Meldung bestehen", async () => {
    const { feedback, lines, metrics } = setup({ reporters: () => Promise.reject(new Error("Zeitüberschreitung")) });
    expect(
      await feedback.report({
        questionId: "co-unit0001",
        guestId: randomUUID(),
        reason: "falsch",
        lobbyCode: null,
        ipKey: null,
      }),
    ).toBe("created");
    expect(lines.some((line) => line.includes("Schutzautomatik: Prüfung fehlgeschlagen"))).toBe(true);
    expect(await metricValue(metrics, "qm_mongo_errors_total", { operation: "quality_check" })).toBe(1);
  });

  it("schlägt nur die Neuberechnung fehl, bleibt die Frage zurückgezogen", async () => {
    const { quality, lines } = setup({ reporters: 3, counts: () => Promise.reject(new Error("weg")) });
    expect(await quality.afterReport("co-unit0001")).toMatchObject({ outcome: "retired", reason: "reports" });
    expect(lines.some((line) => line.includes("Live-Zähler der Kategorie nicht neu berechnet"))).toBe(true);
  });
});

describe("Schutzautomatik – Zeitbudget je Bewertung/Meldung", () => {
  it("aufgebrauchtes Budget: Prüfung geloggt übersprungen, Bewertung gespeichert", async () => {
    const { repos, calls } = fakeRepos();
    const { logger, lines } = capture();
    const metrics = createMetrics({ socketCount: () => 0 });
    const feedback = createFeedbackService({
      repos,
      clock: { now: () => now.getTime() },
      logger,
      metrics,
      budgetMs: 0,
    });
    expect((await feedback.rate("co-unit0001", randomUUID(), -1, ORIGIN)).current).toBe(-1);
    expect(calls.summary).toBe(0);
    expect(lines.some((line) => line.includes("Schutzautomatik übersprungen – Zeitbudget aufgebraucht"))).toBe(true);
  });

  it("hängende Prüfung: Ack nach dem Budget, späterer Fehler wird ebenfalls geloggt", async () => {
    const { repos } = fakeRepos({ summary: () => new Promise<RatingSummary>(() => undefined) });
    const { logger, lines } = capture();
    const metrics = createMetrics({ socketCount: () => 0 });
    const feedback = createFeedbackService({
      repos,
      clock: { now: () => now.getTime() },
      logger,
      metrics,
      budgetMs: 50,
      timeoutMs: 150,
    });
    const started = performance.now();
    expect((await feedback.rate("co-unit0001", randomUUID(), -1, ORIGIN)).current).toBe(-1);
    expect(performance.now() - started).toBeLessThan(140);
    expect(lines.some((line) => line.includes("Schutzautomatik: Prüfung fehlgeschlagen"))).toBe(true);
    await vi.waitFor(() =>
      expect(lines.some((line) => line.includes("Prüfung nach Fristablauf fehlgeschlagen"))).toBe(true),
    );
    expect(await metricValue(metrics, "qm_mongo_errors_total", { operation: "quality_check" })).toBe(1);
  });
});

describe("Schutzautomatik – Schwellen und Übergänge", () => {
  it("Vorfilter: unter 20 Bewertungen insgesamt keine Abfrage; danach Quote seit der letzten Änderung", async () => {
    const few = setup();
    const lowTotal = state({ stats: { shown: 0, correct: 0, likes: 2, dislikes: 17, reports: 0 } });
    const change: RatingChange = { previous: null, current: -1, delta: { likes: 0, dislikes: 1 }, question: lowTotal };
    expect(await few.quality.afterRating("co-unit0001", change)).toEqual({ outcome: "kept", reason: null });
    expect(few.calls.summary).toBe(0);

    const many = setup({ summary: { likes: 5, dislikes: 15 } });
    const enough: RatingChange = { ...change, question: state({ stats: { ...lowTotal.stats, dislikes: 18 } }) };
    expect(await many.quality.afterRating("co-unit0001", enough)).toEqual({
      outcome: "retired",
      reason: "rating",
      ratings: { likes: 5, dislikes: 15 },
      dislikeSources: 3,
    });
    // Genau 30 % → bleibt.
    const border = setup({ summary: { likes: 6, dislikes: 14 } });
    expect(await border.quality.afterRating("co-unit0001", enough)).toMatchObject({ outcome: "kept" });
    expect(border.calls.autoRetire).toBe(0);
  });

  it("Quote greift, aber Daumen-runter aus weniger als 3 unabhängigen Quellen → bleibt im Pool (ADR-058)", async () => {
    const question = state({ stats: { shown: 0, correct: 0, likes: 2, dislikes: 20, reports: 0 } });
    const change: RatingChange = { previous: null, current: -1, delta: { likes: 0, dislikes: 1 }, question };
    const dependent = setup({ summary: { likes: 2, dislikes: 20 }, dislikeSources: 2 });
    expect(await dependent.quality.afterRating("co-unit0001", change)).toEqual({
      outcome: "kept",
      reason: null,
      ratings: { likes: 2, dislikes: 20 },
      dislikeSources: 2,
    });
    expect(dependent.calls.autoRetire).toBe(0);
    // Greift die Quote nicht, werden die Quellen gar nicht erst gezählt.
    const fine = setup({ summary: { likes: 10, dislikes: 12 } });
    expect(await fine.quality.afterRating("co-unit0001", change)).toMatchObject({ outcome: "kept" });
    expect(fine.calls.dislikeSources).toBe(0);
    const independent = setup({ summary: { likes: 2, dislikes: 20 }, dislikeSources: 3 });
    expect(await independent.quality.afterRating("co-unit0001", change)).toMatchObject({
      outcome: "retired",
      reason: "rating",
      dislikeSources: 3,
    });
  });

  it("Feedback reicht die Herkunft (HMAC-IP-Schlüssel, Lobby) an die Repositories weiter (ADR-058)", async () => {
    const { feedback, calls } = setup();
    const origin = { ipKey: "c".repeat(32), lobbyCode: "ABC234" };
    await feedback.rate("co-unit0001", randomUUID(), -1, origin);
    expect(calls.rateOrigins).toEqual([origin]);
    const report = { questionId: "co-unit0001", guestId: randomUUID(), reason: "falsch" as const, ...origin };
    expect(await feedback.report(report)).toBe("created");
    expect(calls.reportsCreated).toEqual([report]);
  });

  it("schon retired oder unbekannt → keine Prüfung", async () => {
    const retired = setup({ quality: state({ status: "retired" }), reporters: 5 });
    expect(await retired.quality.afterReport("co-unit0001")).toEqual({ outcome: "skipped", reason: null });
    expect(retired.calls.reporters).toBe(0);
    const missing = setup({ quality: null, reporters: 5 });
    expect(await missing.quality.afterReport("co-unit0001", null)).toEqual({ outcome: "skipped", reason: null });
    const noQuestion: RatingChange = { previous: null, current: 1, delta: { likes: 1, dislikes: 0 }, question: null };
    expect(await missing.quality.afterRating("co-unit0001", noQuestion)).toEqual({ outcome: "skipped", reason: null });
  });

  it("parallele Prüfungen: genau ein Übergang wird gezählt und geloggt", async () => {
    let first = true;
    const { quality, metrics, lines, calls } = setup({
      reporters: 3,
      autoRetire: async () => {
        const result = first;
        first = false;
        return result;
      },
    });
    const results = await Promise.all([quality.afterReport("co-unit0001"), quality.afterReport("co-unit0001")]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["retired", "skipped"]);
    expect(calls.autoRetire).toBe(2);
    expect(await metricValue(metrics, AUTO_RETIRED_METRIC, { reason: "reports" })).toBe(1);
    const retiredLogs = lines.filter((line) => line.includes("Frage aus dem Pool genommen"));
    expect(retiredLogs).toHaveLength(1);
    expect(JSON.parse(retiredLogs[0] ?? "{}")).toMatchObject({
      question: "co-unit0001",
      category: "comics",
      reason: "reports",
      reporters: 3,
    });
    expect(calls.applyCounts).toBe(1);
  });
});

describe("Schutzautomatik – Missbrauchsbremse (Tagesbudget je Kategorie und insgesamt)", () => {
  it("Kategorie-Budget erschöpft: Frage bleibt im Pool, Metrik und Fehler-Log ohne guestIds", async () => {
    const { quality, calls, metrics, lines } = setup({
      reporters: 3,
      retiredSince: async (_since, category) => (category === undefined ? 5 : AUTO_RETIRE_BUDGET.perCategory),
    });
    expect(await quality.afterReport("co-unit0001")).toEqual({
      outcome: "suppressed",
      reason: "reports",
      reporters: 3,
    });
    expect(calls.autoRetire).toBe(0);
    expect(calls.retiredSince.map((call) => call.category)).toContain("comics");
    expect(calls.retiredSince[0]?.since).toEqual(new Date(now.getTime() - AUTO_RETIRE_BUDGET.windowMs));
    expect(await metricValue(metrics, AUTO_RETIRE_SUPPRESSED_METRIC, { reason: "reports" })).toBe(1);
    expect(await metricValue(metrics, AUTO_RETIRED_METRIC, { reason: "reports" })).toBe(0);
    const log = lines.find((line) => line.includes("Tagesbudget"));
    expect(JSON.parse(log ?? "{}")).toMatchObject({
      level: 50,
      question: "co-unit0001",
      category: "comics",
      scope: "category",
      used: AUTO_RETIRE_BUDGET.perCategory,
      limit: AUTO_RETIRE_BUDGET.perCategory,
    });
  });

  it("Gesamtbudget erschöpft (alle Kategorien): auch Bewertungen ziehen nicht mehr zurück", async () => {
    const { quality, calls, metrics } = setup({
      summary: { likes: 1, dislikes: 19 },
      retiredSince: async (_since, category) => (category === undefined ? AUTO_RETIRE_BUDGET.total : 0),
    });
    const question = state({ stats: { shown: 0, correct: 0, likes: 1, dislikes: 19, reports: 0 } });
    const change: RatingChange = { previous: null, current: -1, delta: { likes: 0, dislikes: 1 }, question };
    expect(await quality.afterRating("co-unit0001", change)).toMatchObject({ outcome: "suppressed", reason: "rating" });
    expect(calls.autoRetire).toBe(0);
    expect(await metricValue(metrics, AUTO_RETIRE_SUPPRESSED_METRIC, { reason: "rating" })).toBe(1);
  });

  it("parallele fällige Prüfungen überschreiten das Budget nicht (Prüfen und Zurückziehen nacheinander)", async () => {
    let retired = 0;
    const { quality, calls, metrics } = setup({
      reporters: 3,
      retiredSince: async () => retired,
      autoRetire: async () => {
        // Langsamer Store: ohne Reihenfolge sähen alle Prüfungen denselben (alten) Stand.
        await new Promise((resolve) => setTimeout(resolve, 5));
        retired += 1;
        return true;
      },
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        quality.afterReport(`co-unit000${index}`, state({ _id: `co-unit000${index}` })),
      ),
    );
    const outcomes = results.map((result) => result.outcome);
    expect(outcomes.filter((outcome) => outcome === "retired")).toHaveLength(AUTO_RETIRE_BUDGET.perCategory);
    expect(outcomes.filter((outcome) => outcome === "suppressed")).toHaveLength(8 - AUTO_RETIRE_BUDGET.perCategory);
    expect(calls.autoRetire).toBe(AUTO_RETIRE_BUDGET.perCategory);
    expect(await metricValue(metrics, AUTO_RETIRED_METRIC, { reason: "reports" })).toBe(AUTO_RETIRE_BUDGET.perCategory);
  });

  it("Budget nicht lesbar → kein Zurückziehen (fail closed), Fehler bleibt beim Feedback geloggt", async () => {
    const { feedback, calls, lines, metrics } = setup({
      reporters: 3,
      retiredSince: () => Promise.reject(new Error("Netzwerk weg")),
    });
    expect(
      await feedback.report({
        questionId: "co-unit0001",
        guestId: randomUUID(),
        reason: "falsch",
        lobbyCode: "ABC234",
        ipKey: null,
      }),
    ).toBe("created");
    expect(calls.autoRetire).toBe(0);
    expect(lines.some((line) => line.includes("Schutzautomatik: Prüfung fehlgeschlagen"))).toBe(true);
    expect(await metricValue(metrics, "qm_mongo_errors_total", { operation: "auto_retire_budget" })).toBe(1);
  });
});

describe("Live-Zähler", () => {
  it("je Kategorie höchstens eine laufende und eine folgende Neuberechnung", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { quality, calls } = setup({
      applyCounts: async () => {
        await blocked;
        return recountResult(true, true);
      },
    });
    const runs = [1, 2, 3, 4].map(() => quality.recountCategory("comics"));
    await vi.waitFor(() => expect(calls.countPlayable).toBe(1));
    release?.();
    const results = await Promise.all(runs);
    expect(results.every((result) => result?.categoryId === "comics")).toBe(true);
    expect(calls.countPlayable).toBe(2);
    expect(calls.applyCounts).toBe(2);
    // Danach startet eine neue Anforderung wieder sofort.
    await quality.recountCategory("comics");
    expect(calls.countPlayable).toBe(3);
  });

  it("unter der Mindestmenge: Warnung; Mindestmenge aus appConfig im Speicher, sonst aus der DB", async () => {
    const fromDb = setup({ applyCounts: async () => recountResult(true, false), minPlayable: 11 });
    expect(await fromDb.quality.recountCategory("comics")).toMatchObject({ after: { playable: false } });
    expect(fromDb.calls.appConfig).toBe(1);
    const warning = fromDb.lines.find((line) => line.includes("Kategorie unter der Mindestmenge"));
    expect(JSON.parse(warning ?? "{}")).toMatchObject({ category: "comics", minPlayable: 11, pool: "all" });

    const config = defaultAppConfig(now);
    const live = setup(
      { applyCounts: async () => recountResult(false, true) },
      { appConfig: { get: () => ({ ...config, catalog: { ...config.catalog, minPlayable: 7 } }) }, pool: "approved" },
    );
    await live.quality.recountCategory("comics");
    expect(live.calls.appConfig).toBe(0);
    const info = live.lines.find((line) => line.includes("Kategorie wieder spielbar"));
    expect(JSON.parse(info ?? "{}")).toMatchObject({ minPlayable: 7, pool: "approved" });
  });
});
