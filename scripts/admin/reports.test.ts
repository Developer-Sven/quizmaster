/**
 * `pnpm admin:reports` (docs/08 §5, §8): Argumente, Prod-Schutz vor jedem Dateizugriff, Ausgabe der Prüf-Queue
 * (Text und JSON für /faktencheck) ohne guestIds/Lobby-Codes, Aktionen --resolve/--dismiss/--restore gegen die
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

  it("Text und JSON: gruppiert je Frage, priorisiert, mit Datei und Hinweisen für /faktencheck", async () => {
    const [reported, retired] = await questionsOf("musik-hits", 2);
    if (reported === undefined || retired === undefined) throw new Error("Fixtures fehlen");
    const reasons = ["falsch", "veraltet", "tippfehler"] as const;
    for (const [index, reason] of reasons.entries()) {
      await repos.reports.create(
        { questionId: reported._id, reason, guestId: guests[index] ?? randomUUID(), lobbyCode: "QWE234" },
        new Date(now.getTime() - (2 - index) * DAY_MS),
      );
    }
    await repos.reports.create(
      { questionId: retired._id, reason: "mehrdeutig", guestId: guests[3] ?? randomUUID(), lobbyCode: "QWE234" },
      now,
    );
    expect(await repos.questions.autoRetire(retired._id, "reports", now)).toBe(true);

    const queue = await buildReviewQueue(repos, { now, readPreference: "primary" });
    const context = { env: "dev" as const, database: t.dbName };
    const json = queueToJson(queue, context);
    expect(json).toMatchObject({ schemaVersion: 1, kind: "quizmaster-review-queue", env: "dev" });
    expect(json.thresholds.autoRetire).toEqual({
      reports: { minReporters: 3, windowDays: 7, reasons: ["falsch", "veraltet", "mehrdeutig"] },
      rating: { minRatings: 20, belowPercent: 30 },
    });
    const ids = json.items.map((item) => item.questionId);
    expect(ids.indexOf(reported._id)).toBeLessThan(ids.indexOf(retired._id)); // 2 schwere Meldungen vor 1
    const first = json.items.find((item) => item.questionId === reported._id);
    expect(first).toMatchObject({
      file: `questions/musik-hits/${reported.topic}.json`,
      flags: ["reports"],
      tier: 0,
      reports: { open: 3, reporters: 3, severeReporters: 2, byReason: { falsch: 1, veraltet: 1, tippfehler: 1 } },
    });
    expect(first?.reports?.reportIds).toHaveLength(3);
    expect(first?.hints.join(" ")).toContain("falsch 1, veraltet 1, tippfehler 1");
    const second = json.items.find((item) => item.questionId === retired._id);
    expect(second).toMatchObject({ flags: ["auto_retired", "reports"], status: "retired" });
    expect(second?.hints[0]).toContain("automatisch zurückgezogen (Meldungen)");

    const text = formatQueueText(queue, context).join("\n");
    expect(text).toContain(`${reported._id} · musik-hits/${reported.topic} · unverified · [MELDUNGEN]`);
    expect(text).toContain(`[ZURÜCKGEZOGEN · MELDUNGEN]`);
    expect(text).toContain("3 offene Meldungen von 3 Gästen");
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
          { questionId: question._id, reason: "falsch", guestId: randomUUID(), lobbyCode: null },
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
      { questionId: question._id, reason: "falsch", guestId: randomUUID(), lobbyCode: null },
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
