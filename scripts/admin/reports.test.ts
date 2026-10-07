/**
 * `pnpm admin:reports` (docs/08 §5, §8): Argumente, Prod-Schutz vor jedem Dateizugriff, Ausgabe der Prüf-Queue
 * (Text und JSON für den Faktencheck) ohne guestIds/Lobby-Codes, Aktionen --resolve/--dismiss/--restore gegen die
 * Test-DB (Fixtures-Katalog aus einer Kopie in einem temporären Content-Ordner).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildReviewQueue, createRepositories, questionContentHash, type Repositories } from "@quizmaster/db";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { questionFileSchema } from "@quizmaster/shared/content";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURES_CONTENT_DIR, REPO_ROOT } from "../content/lib/paths.ts";
import { runSeed } from "../content/lib/seed-runner.ts";
import {
  contentFileOf,
  describeActionResult,
  formatQueueText,
  parseReportsArgs,
  parseReportTarget,
  queueToJson,
  ReportsActionError,
  ReportsUsageError,
  reportsActionFailed,
  restoreQuestion,
  runReportsAction,
} from "./reports.ts";

const run = promisify(execFile);
const CLI = join(REPO_ROOT, "scripts", "admin", "reports.ts");
const now = new Date("2026-10-01T10:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

let t: TestDatabase;
let repos: Repositories;
let contentDir: string;

beforeAll(async () => {
  t = await createTestDatabase({ ensureIndexes: true });
  repos = createRepositories(t.client, t.collections);
  contentDir = mkdtempSync(join(tmpdir(), "qm-admin-reports-"));
  cpSync(FIXTURES_CONTENT_DIR, contentDir, { recursive: true });
  await runSeed(t.db, { env: "dev", contentDir, dryRun: false, allowMassRetire: false, prefix: t.prefix });
}, 120_000);

afterAll(async () => {
  if (contentDir) rmSync(contentDir, { recursive: true, force: true });
  await t?.cleanup();
});

async function cli(args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: REPO_ROOT });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

/** Unverifizierte Fixture-Fragen einer Kategorie mit Thema. */
async function questionsOf(category: string, count: number) {
  const docs = await t.collections.questions
    .find({ category, status: "unverified" }, { projection: { _id: 1, topic: 1, contentHash: 1 } })
    .sort({ _id: 1 })
    .limit(count)
    .toArray();
  if (docs.length < count) throw new Error(`Zu wenige Fixture-Fragen in ${category}`);
  return docs;
}

describe("Argumente und Prod-Schutz", () => {
  it("Standard: Liste in dev; Ziele als Fragen- oder Meldungs-ID; nur eine Aktion", () => {
    expect(parseReportsArgs([])).toMatchObject({
      env: "dev",
      confirmProd: false,
      json: false,
      action: { kind: "list" },
    });
    expect(parseReportsArgs(["--json", "--env", "prod", "--confirm-prod"])).toMatchObject({
      env: "prod",
      confirmProd: true,
      json: true,
    });
    expect(parseReportsArgs(["--resolve", "rw-8f3k2m1q"]).action).toEqual({
      kind: "resolve",
      target: { questionId: "rw-8f3k2m1q" },
    });
    const reportId = randomUUID();
    expect(parseReportsArgs(["--dismiss", reportId.toUpperCase()]).action).toEqual({
      kind: "dismiss",
      target: { reportId },
    });
    expect(parseReportsArgs(["--restore", "rw-8f3k2m1q"]).action).toEqual({
      kind: "restore",
      questionId: "rw-8f3k2m1q",
    });
    expect(() => parseReportsArgs(["--resolve", "rw-8f3k2m1q", "--restore", "rw-8f3k2m1q"])).toThrow(ReportsUsageError);
    expect(() => parseReportsArgs(["--restore", reportId])).toThrow(ReportsUsageError);
    expect(() => parseReportsArgs(["--env", "staging"])).toThrow(ReportsUsageError);
    expect(() => parseReportsArgs(["--unbekannt"])).toThrow(ReportsUsageError);
    expect(() => parseReportTarget("{ $ne: null }")).toThrow(ReportsUsageError);
  });

  it("--env prod ohne --confirm-prod bricht vor jedem Lesen der Env-Datei ab", async () => {
    const result = await cli(["--env", "prod", "--json"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("--confirm-prod");
    expect(result.output).not.toContain("mongodb");
    const usage = await cli(["--resolve", "x"]);
    expect(usage.code).toBe(2);
    expect(usage.output).toContain("Aufruf: pnpm admin:reports");
  });
});

describe("Prüf-Queue: Ausgabe ohne guestIds", () => {
  const guests = Array.from({ length: 5 }, () => randomUUID());

  it("Text und JSON: gruppiert je Frage, priorisiert, mit Datei und Hinweisen für den Faktencheck", async () => {
    const [reported, retired] = await questionsOf("musik-hits", 2);
    if (reported === undefined || retired === undefined) throw new Error("Fixtures fehlen");
    const reasons = ["falsch", "veraltet", "tippfehler"] as const;
    for (const [index, reason] of reasons.entries()) {
      await repos.reports.create(
        { questionId: reported._id, reason, guestId: guests[index] ?? randomUUID(), lobbyCode: "QWE234", ipKey: null },
        new Date(now.getTime() - (2 - index) * DAY_MS),
      );
    }
    await repos.reports.create(
      {
        questionId: retired._id,
        reason: "mehrdeutig",
        guestId: guests[3] ?? randomUUID(),
        lobbyCode: "QWE234",
        ipKey: null,
      },
      now,
    );
    expect(await repos.questions.autoRetire(retired._id, "reports", now)).toBe(true);

    const queue = await buildReviewQueue(repos, { now, readPreference: "primary" });
    const context = { env: "dev" as const, database: t.dbName };
    const json = queueToJson(queue, context);
    expect(json).toMatchObject({ schemaVersion: 1, kind: "quizmaster-review-queue", env: "dev" });
    expect(json.thresholds.autoRetire).toEqual({
      reports: { minReporters: 3, windowDays: 7, reasons: ["falsch", "veraltet", "mehrdeutig"] },
      rating: { minRatings: 20, belowPercent: 30, minDislikeSources: 3 },
      budget: { windowHours: 24, perCategory: 5, total: 20 },
    });
    const ids = json.items.map((item) => item.questionId);
    expect(ids.indexOf(reported._id)).toBeLessThan(ids.indexOf(retired._id)); // 2 schwere Meldungen vor 1
    const first = json.items.find((item) => item.questionId === reported._id);
    expect(first).toMatchObject({
      file: `questions/musik-hits/${reported.topic}.json`,
      flags: ["reports"],
      tier: 0,
      reports: {
        open: 3,
        reporters: 3,
        severeReporters: 2,
        // Alle aus derselben Lobby: eine unabhängige Quelle (ADR-058).
        severeSources: 1,
        byReason: { falsch: 1, veraltet: 1, tippfehler: 1 },
      },
    });
    expect(first?.reports?.reportIds).toHaveLength(3);
    expect(first?.hints.join(" ")).toContain("falsch 1, veraltet 1, tippfehler 1");
    const second = json.items.find((item) => item.questionId === retired._id);
    expect(second).toMatchObject({ flags: ["auto_retired", "reports"], status: "retired" });
    expect(second?.hints[0]).toContain("automatisch zurückgezogen (Meldungen)");

    const text = formatQueueText(queue, context).join("\n");
    expect(text).toContain(`${reported._id} · musik-hits/${reported.topic} · unverified · [MELDUNGEN]`);
    expect(text).toContain(`[ZURÜCKGEZOGEN · MELDUNGEN]`);
    expect(text).toContain("3 offene Meldungen von 3 Gästen, schwere Gründe aus 1 unabhängigen Quelle");
    expect(text).toContain(`Datei: content/questions/musik-hits/${reported.topic}.json`);
    // Weder guestIds noch Lobby-Codes verlassen die Datenbank.
    const serialized = `${JSON.stringify(json)}\n${text}`;
    for (const guest of guests) expect(serialized).not.toContain(guest);
    expect(serialized).not.toContain("guestId");
    expect(serialized).not.toContain("QWE234");
    expect(contentFileOf({ category: null, topic: null })).toBeNull();
  });

  it("leere Queue ist eindeutig", () => {
    const text = formatQueueText(
      {
        generatedAt: now,
        items: [],
        totals: { items: 0, openReports: 0, questionsWithReports: 0, autoRetired: 0, lowRating: 0, lowHitRate: 0 },
        truncated: { reports: false, autoRetired: false },
        thresholds: {
          ratingWatch: { minRatings: 10, belowPercent: 50 },
          calibration: { minShown: 30, reviewBelowPercent: 10 },
        },
      },
      { env: "dev", database: "quizmaster_dev" },
    );
    expect(text.at(-1)).toBe("Keine Fragen zu prüfen.");
  });
});

describe("Aktionen", () => {
  it("--resolve je Frage, --dismiss je Meldung (nur offene)", async () => {
    const [question] = await questionsOf("zeugen-der-zeit", 1);
    if (question === undefined) throw new Error("Fixtures fehlen");
    const created = [];
    for (let index = 0; index < 3; index++) {
      created.push(
        await repos.reports.create(
          { questionId: question._id, reason: "falsch", guestId: randomUUID(), lobbyCode: null, ipKey: null },
          now,
        ),
      );
    }
    const options = { contentDir, pool: "all" as const, now };
    const single = await runReportsAction(
      repos,
      { kind: "dismiss", target: { reportId: created[0]?._id ?? "" } },
      options,
    );
    expect(single).toEqual({ action: "dismiss", target: { reportId: created[0]?._id }, changed: 1 });
    expect(describeActionResult(single)).toContain("1 offene Meldung(en)");
    const all = await runReportsAction(repos, { kind: "resolve", target: { questionId: question._id } }, options);
    expect(all).toMatchObject({ action: "resolve", changed: 2 });
    const again = await runReportsAction(repos, { kind: "resolve", target: { questionId: question._id } }, options);
    expect(describeActionResult(again)).toContain("keine offene Meldung");
    const statuses = await t.collections.questionReports.find({ questionId: question._id }).toArray();
    expect(statuses.map((report) => report.status).sort()).toEqual(["dismissed", "resolved", "resolved"]);
  });

  it("--restore: Status aus dem Repo, Live-Zähler, Hinweis auf offene Meldungen", async () => {
    const [question] = await questionsOf("glaube-religion", 1);
    if (question === undefined) throw new Error("Fixtures fehlen");
    const countsBefore = await repos.questions.countPlayable("glaube-religion");
    await repos.reports.create(
      { questionId: question._id, reason: "falsch", guestId: randomUUID(), lobbyCode: null, ipKey: null },
      now,
    );
    expect(await repos.questions.autoRetire(question._id, "reports", now)).toBe(true);
    const result = await restoreQuestion(repos, question._id, { contentDir, pool: "all", now });
    expect(result).toEqual({
      questionId: question._id,
      status: "unverified",
      category: "glaube-religion",
      categoryPlayable: true,
      playableCount: countsBefore.playableCount,
      openReports: 1,
    });
    expect(describeActionResult({ action: "restore", ...result })).toContain(`--dismiss ${question._id}`);
    expect(await repos.questions.findQualityState(question._id)).toMatchObject({
      status: "unverified",
      autoRetired: null,
    });
    await expect(restoreQuestion(repos, question._id, { contentDir, pool: "all", now })).rejects.toThrow(
      /nicht automatisch zurückgezogen/,
    );
  });

  it("--restore verweigert im Repo geänderte, needs_fix- und fehlende Fragen", async () => {
    // Zwei Fragen aus derselben Themen-Datei.
    const sameTopic = await t.collections.questions
      .find({ category: "im-labor", topic: "grundlagen", status: "unverified" }, { projection: { _id: 1, topic: 1 } })
      .sort({ _id: 1 })
      .limit(2)
      .toArray();
    const [changed, broken] = sameTopic;
    if (changed === undefined || broken === undefined) throw new Error("Fixtures fehlen");
    const file = join(contentDir, "questions", "im-labor", `${changed.topic}.json`);
    const original = readFileSync(file, "utf8");
    try {
      // 1. Fassung im Repo geändert (anderer Hash) → Seed übernimmt sie.
      const parsed = questionFileSchema.parse(JSON.parse(original));
      const edited = {
        ...parsed,
        questions: parsed.questions.map((entry) =>
          entry.id === changed._id ? { ...entry, explanation: "Neue Erklärung nach Prüfung." } : entry,
        ),
      };
      writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
      await repos.questions.autoRetire(changed._id, "rating", now);
      await expect(restoreQuestion(repos, changed._id, { contentDir, pool: "all", now })).rejects.toThrow(
        /pnpm content:seed übernimmt die neue Fassung/,
      );

      // 2. Im Repo needs_fix (DB-Hash passt zur needs_fix-Fassung) → erst korrigieren.
      const needsFix = {
        ...parsed,
        questions: parsed.questions.map((entry) =>
          entry.id === broken._id
            ? {
                ...entry,
                status: "needs_fix" as const,
                review: { checkedAt: "2026-10-01", checkedBy: "fakten-pruefer", notes: "falsch" },
              }
            : entry,
        ),
      };
      writeFileSync(file, `${JSON.stringify(needsFix, null, 2)}\n`);
      const entry = needsFix.questions.find((candidate) => candidate.id === broken._id);
      if (entry === undefined) throw new Error("Eintrag fehlt");
      await t.collections.questions.updateOne(
        { _id: broken._id },
        { $set: { contentHash: questionContentHash(needsFix.category, needsFix.topic, entry) } },
      );
      await repos.questions.autoRetire(broken._id, "reports", now);
      await expect(restoreQuestion(repos, broken._id, { contentDir, pool: "all", now })).rejects.toThrow(
        /im Repo needs_fix/,
      );
    } finally {
      writeFileSync(file, original);
    }
    await expect(restoreQuestion(repos, "il-fehlt001", { contentDir, pool: "all", now })).rejects.toBeInstanceOf(
      ReportsActionError,
    );
    await expect(
      restoreQuestion(repos, changed._id, { contentDir: join(contentDir, "gibt-es-nicht"), pool: "all", now }),
    ).rejects.toThrow(/Content-Datei fehlt/);
  });
});

describe("Massen-Wiederherstellung (--restore-auto, z. B. nach Missbrauch der Meldungen)", () => {
  it("Argumente: --since Pflicht (ISO mit Zone), --reason reports|rating, --dry-run nur mit --restore-auto", () => {
    expect(parseReportsArgs(["--restore-auto", "--since", "2026-10-01T08:00:00Z"]).action).toEqual({
      kind: "restore-auto",
      since: new Date("2026-10-01T08:00:00Z"),
      reason: null,
      dryRun: false,
    });
    expect(
      parseReportsArgs(["--restore-auto", "--since", "2026-10-01", "--reason", "rating", "--dry-run"]).action,
    ).toEqual({ kind: "restore-auto", since: new Date("2026-10-01T00:00:00Z"), reason: "rating", dryRun: true });
    expect(() => parseReportsArgs(["--restore-auto"])).toThrow(/--since/);
    for (const bad of [
      ["--restore-auto", "--since", "gestern"],
      ["--restore-auto", "--since", "2026-10-01 08:00"],
      ["--restore-auto", "--since", "2026-10-01", "--reason", "trolle"],
      ["--dry-run"],
      ["--since", "2026-10-01"],
      ["--reason", "reports"],
      ["--restore-auto", "--since", "2026-10-01", "--restore", "rw-8f3k2m1q"],
    ]) {
      expect(() => parseReportsArgs(bad), bad.join(" ")).toThrow(ReportsUsageError);
    }
  });

  it("stellt alle seit dem Zeitpunkt zurückgezogenen wieder her – Dry-Run, Grund-Filter, geänderte übersprungen", async () => {
    const category = "kinofilme";
    const original = await repos.questions.countPlayable(category);
    const [first, second, third, changed] = await questionsOf(category, 4);
    if (first === undefined || second === undefined || third === undefined || changed === undefined) {
      throw new Error("Fixtures fehlen");
    }
    const hour = 3_600_000;
    const at = (hoursAgo: number) => new Date(now.getTime() + 30 * DAY_MS - hoursAgo * hour);
    expect(await repos.questions.autoRetire(first._id, "reports", at(4))).toBe(true);
    expect(await repos.questions.autoRetire(second._id, "rating", at(3))).toBe(true);
    expect(await repos.questions.autoRetire(third._id, "reports", at(2))).toBe(true);
    // Im Repo inzwischen geändert (anderer Hash) → übernimmt der Seed, nicht die Wiederherstellung.
    await t.collections.questions.updateOne({ _id: changed._id }, { $set: { contentHash: "f".repeat(64) } });
    expect(await repos.questions.autoRetire(changed._id, "reports", at(1))).toBe(true);
    const options = { contentDir, pool: "all" as const, now: at(0) };

    const preview = await runReportsAction(
      repos,
      { kind: "restore-auto", since: at(3), reason: null, dryRun: true },
      options,
    );
    expect(preview).toMatchObject({
      action: "restore-auto",
      dryRun: true,
      candidates: 3,
      truncated: false,
      restored: [
        { questionId: third._id, status: "unverified", category },
        { questionId: second._id, status: "unverified", category },
      ],
      skipped: [{ questionId: changed._id, problem: expect.stringContaining("im Repo geändert") }],
      categories: [],
    });
    expect(await repos.questions.findQualityState(second._id)).toMatchObject({ status: "retired" });
    expect(describeActionResult(preview)).toContain("Dry-Run – würde 2 von 3 automatisch zurückgezogenen Fragen");

    const reportsOnly = await runReportsAction(
      repos,
      { kind: "restore-auto", since: at(3), reason: "reports", dryRun: false },
      options,
    );
    expect(reportsOnly).toMatchObject({ candidates: 2, restored: [{ questionId: third._id }] });
    expect(await repos.questions.findQualityState(third._id)).toMatchObject({
      status: "unverified",
      autoRetired: null,
    });
    expect(await repos.questions.findQualityState(second._id)).toMatchObject({ status: "retired" });

    const all = await runReportsAction(
      repos,
      { kind: "restore-auto", since: at(5), reason: null, dryRun: false },
      options,
    );
    expect(all).toMatchObject({
      candidates: 3,
      restored: [{ questionId: second._id }, { questionId: first._id }],
      skipped: [{ questionId: changed._id }],
      categories: [{ category, playable: true, playableCount: original.playableCount - 1 }],
    });
    const text = describeActionResult(all);
    expect(text).toContain("2 von 3 automatisch zurückgezogenen Fragen");
    expect(text).toContain(`übersprungen: ${changed._id}`);
    expect(text).toContain(`Kategorie ${category}: ${original.playableCount - 1} spielbare Fragen, spielbar`);
    for (const question of [first, second, third]) {
      expect(await repos.questions.findQualityState(question._id)).toMatchObject({
        status: "unverified",
        autoRetired: null,
      });
    }
    expect(await repos.questions.findQualityState(changed._id)).toMatchObject({ status: "retired" });
  });

  /** Zurückgezogen `hoursAgo` Stunden vor einem eigenen Zeitfenster (60 Tage nach `now`, getrennt von den anderen Tests). */
  const late = (hoursAgo: number) => new Date(now.getTime() + 60 * DAY_MS - hoursAgo * 3_600_000);

  /** Live-Zähler einer Kategorie, wie sie in `categories` gespeichert sind. */
  async function storedCounts(category: string) {
    const doc = await t.collections.categories.findOne({ _id: category });
    return { playable: doc?.playable, playableCount: doc?.playableCount };
  }

  it("Abbruch mitten im Lauf: die schon wiederhergestellten Kategorien werden trotzdem neu gezählt (Exit 1)", async () => {
    const [newest, middle] = await questionsOf("comics", 2);
    const [oldest] = await questionsOf("tv-serien", 1);
    if (newest === undefined || middle === undefined || oldest === undefined) throw new Error("Fixtures fehlen");
    const comics = await repos.questions.countPlayable("comics");
    const tv = await repos.questions.countPlayable("tv-serien");
    // Neueste zuerst: newest (comics), middle (comics), oldest (tv-serien).
    expect(await repos.questions.autoRetire(oldest._id, "reports", late(3))).toBe(true);
    expect(await repos.questions.autoRetire(middle._id, "reports", late(2))).toBe(true);
    expect(await repos.questions.autoRetire(newest._id, "rating", late(1))).toBe(true);
    // Die Zähler stehen noch auf dem Stand vor den Rückzügen (die Schutzautomatik zählt sie im Betrieb neu).
    await repos.categories.applyCounts(
      "comics",
      { playableCount: 0, approvedCount: 0 },
      { minPlayable: 1, pool: "all" },
      now,
    );
    expect(await storedCounts("comics")).toEqual({ playable: false, playableCount: 0 });

    // Die Datenbank fällt beim zweiten Wiederherstellen weg (z. B. Netzaussetzer während des Alarms).
    let restoreCalls = 0;
    const flaky: Repositories = {
      ...repos,
      questions: {
        ...repos.questions,
        restoreAutoRetired: async (...args: Parameters<Repositories["questions"]["restoreAutoRetired"]>) => {
          restoreCalls += 1;
          if (restoreCalls === 2) throw new Error("Verbindung zur Datenbank verloren");
          return repos.questions.restoreAutoRetired(...args);
        },
      },
    };
    const options = { contentDir, pool: "all" as const, now: late(0) };
    const action = { kind: "restore-auto" as const, since: late(4), reason: null, dryRun: false };
    const aborted = await runReportsAction(flaky, action, options);
    expect(aborted).toMatchObject({
      action: "restore-auto",
      candidates: 3,
      restored: [{ questionId: newest._id, category: "comics" }],
      skipped: [],
      aborted: { questionId: middle._id, problem: expect.stringContaining("Verbindung zur Datenbank verloren") },
      categories: [{ category: "comics", playable: true, playableCount: comics.playableCount - 1, problem: null }],
    });
    expect(reportsActionFailed(aborted)).toBe(true);
    expect(await storedCounts("comics")).toEqual({ playable: true, playableCount: comics.playableCount - 1 });
    const text = describeActionResult(aborted);
    expect(text).toContain(`ABGEBROCHEN bei ${middle._id}: `);
    expect(text).toContain("Verbindung zur Datenbank verloren");

    // Ein neuer Lauf findet nur noch die übrigen – und zählt deren Kategorien neu.
    const rest = await runReportsAction(repos, action, options);
    expect(rest).toMatchObject({
      candidates: 2,
      restored: [{ questionId: middle._id }, { questionId: oldest._id }],
      aborted: null,
      categories: [
        { category: "comics", playableCount: comics.playableCount, problem: null },
        { category: "tv-serien", playableCount: tv.playableCount, problem: null },
      ],
    });
    expect(reportsActionFailed(rest)).toBe(false);
  });

  it("scheitert die Neuberechnung einer Kategorie, laufen die übrigen weiter – mit Hinweis auf --recount (Exit 1)", async () => {
    const [comic] = await questionsOf("comics", 1);
    const [sport] = await questionsOf("sport-freizeit", 1);
    if (comic === undefined || sport === undefined) throw new Error("Fixtures fehlen");
    expect(await repos.questions.autoRetire(comic._id, "reports", late(2))).toBe(true);
    expect(await repos.questions.autoRetire(sport._id, "reports", late(1))).toBe(true);
    const flaky: Repositories = {
      ...repos,
      categories: {
        ...repos.categories,
        applyCounts: async (...args: Parameters<Repositories["categories"]["applyCounts"]>) => {
          if (args[0] === "comics") throw new Error("Zeitüberschreitung");
          return repos.categories.applyCounts(...args);
        },
      },
    };
    const options = { contentDir, pool: "all" as const, now: late(0) };
    const result = await runReportsAction(
      flaky,
      { kind: "restore-auto", since: late(3), reason: null, dryRun: false },
      options,
    );
    expect(result).toMatchObject({
      restored: [{ questionId: sport._id }, { questionId: comic._id }],
      aborted: null,
      categories: [
        {
          category: "comics",
          playable: null,
          playableCount: null,
          problem: expect.stringContaining("Zeitüberschreitung"),
        },
        { category: "sport-freizeit", playable: true, problem: null },
      ],
    });
    expect(reportsActionFailed(result)).toBe(true);
    const text = describeActionResult(result);
    expect(text).toContain("Kategorie comics: Live-Zähler NICHT neu berechnet");
    expect(text).toContain("pnpm admin:reports --recount comics");

    // Nachholen: --recount zählt die Kategorie neu und schreibt die Live-Zähler.
    const expected = await repos.questions.countPlayable("comics");
    const recount = await runReportsAction(repos, { kind: "recount", category: "comics" }, options);
    expect(recount).toEqual({
      action: "recount",
      category: "comics",
      playable: true,
      playableCount: expected.playableCount,
    });
    expect(reportsActionFailed(recount)).toBe(false);
    expect(await storedCounts("comics")).toEqual({ playable: true, playableCount: expected.playableCount });
    expect(describeActionResult(recount)).toBe(
      `Kategorie comics neu gezählt: ${expected.playableCount} spielbare Fragen, spielbar`,
    );
    await expect(
      runReportsAction(repos, { kind: "recount", category: "gibt-es-nicht" }, options),
    ).rejects.toBeInstanceOf(ReportsActionError);
  });

  it("--recount <kategorie>: Argumente", () => {
    expect(parseReportsArgs(["--recount", "comics"]).action).toEqual({ kind: "recount", category: "comics" });
    for (const bad of [
      ["--recount", "Comics!"],
      ["--recount", "comics", "--restore", "rw-8f3k2m1q"],
      ["--recount", "comics", "--restore-auto", "--since", "2026-10-01"],
    ]) {
      expect(() => parseReportsArgs(bad), bad.join(" ")).toThrow(ReportsUsageError);
    }
  });
});
