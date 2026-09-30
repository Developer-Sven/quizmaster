import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SeedAbortError } from "@quizmaster/db";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { APP_CONFIG_ID } from "@quizmaster/shared/documents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURES_CONTENT_DIR, REPO_ROOT } from "./lib/paths.ts";
import { assertProdConfirmed, assertTargetDatabase, SeedGuardError } from "./lib/seed-guard.ts";
import { describeSeedRun, prepareSeed, runSeed } from "./lib/seed-runner.ts";

const run = promisify(execFile);
const SEED_CLI = join(REPO_ROOT, "scripts", "content", "seed.ts");

let t: TestDatabase;
let workDir: string;

beforeAll(async () => {
  t = await createTestDatabase();
  workDir = mkdtempSync(join(tmpdir(), "qm-seed-"));
}, 120_000);

afterAll(async () => {
  rmSync(workDir, { recursive: true, force: true });
  await t?.cleanup();
});

/** Startet die Seed-CLI (ohne .env-Zugriff, weil die Sicherheitsprüfungen vorher abbrechen). */
async function seedCli(args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [SEED_CLI, ...args], { cwd: REPO_ROOT });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

describe("content:seed – Katalog-Import über den Harness", () => {
  it("seedet die Fixtures, zweiter Lauf ist ein No-op", { timeout: 120_000 }, async () => {
    const options = { env: "dev" as const, contentDir: FIXTURES_CONTENT_DIR, allowMassRetire: false, prefix: t.prefix };
    const dry = await runSeed(t.db, { ...options, dryRun: true });
    expect(dry.result.changes).toBeGreaterThan(200);
    expect(await t.collections.questions.countDocuments()).toBe(0);

    const first = await runSeed(t.db, { ...options, dryRun: false });
    expect(first.fixtures).toBe(true);
    // 209 Fixture-Fragen; die neue needs_fix/retired-Frage wird gar nicht erst angelegt.
    expect(first.result.after).toEqual({
      questions: 207,
      byStatus: { unverified: 188, approved: 19 },
      categories: 19,
      playableCategories: 19,
    });
    expect(describeSeedRun(first).join("\n")).toContain("Datenbank danach: 207 Fragen");
    const config = await t.collections.appConfig.findOne({ _id: APP_CONFIG_ID });
    expect(config?.catalog?.minPlayable).toBe(3);
    const flag = await t.collections.questions.findOne({ "media.code": "gb-eng" });
    expect(flag).toMatchObject({
      category: "rund-um-die-welt",
      topic: "flaggen",
      media: { kind: "flag", code: "gb-eng" },
    });

    const again = await runSeed(t.db, { ...options, dryRun: true });
    expect(again.result.changes).toBe(0);
    const second = await runSeed(t.db, { ...options, dryRun: false });
    expect(second.result.changes).toBe(0);
    expect(second.result.written?.inserted).toBe(0);
  });

  it("Sicherheitsnetz: Massen-Retire bricht ab, --allow-mass-retire erlaubt es", { timeout: 120_000 }, async () => {
    const reduced = join(workDir, "reduziert");
    cpSync(FIXTURES_CONTENT_DIR, reduced, { recursive: true });
    for (const category of ["comics", "kinofilme"]) rmSync(join(reduced, "questions", category, "grundlagen.json"));
    const options = { env: "dev" as const, contentDir: reduced, prefix: t.prefix, dryRun: false };
    await expect(runSeed(t.db, { ...options, allowMassRetire: false })).rejects.toBeInstanceOf(SeedAbortError);
    expect(await t.collections.questions.countDocuments({ status: "retired" })).toBe(0);
    const allowed = await runSeed(t.db, { ...options, allowMassRetire: true });
    expect(allowed.result.written?.retired).toBeGreaterThan(10);
    expect(await t.collections.questions.countDocuments()).toBe(207);
  });

  it("Sicherheitsnetz: leeres oder fehlendes Verzeichnis", () => {
    const empty = join(workDir, "leer");
    mkdirSync(empty);
    expect(() => prepareSeed({ env: "dev", contentDir: empty }, "quizmaster_test")).toThrow(SeedGuardError);
    expect(() => prepareSeed({ env: "dev", contentDir: join(workDir, "gibtsnicht") }, undefined)).toThrow(
      /Content-Ordner fehlt/,
    );
  });

  it("Sicherheitsnetz: Fixtures nie gegen Produktion, Präfix nur *_test, prod nur mit --confirm-prod", async () => {
    expect(() => prepareSeed({ env: "prod", contentDir: FIXTURES_CONTENT_DIR }, "quizmaster")).toThrow(
      /Fixtures dürfen nie in Produktion/,
    );
    expect(() => prepareSeed({ env: "dev", contentDir: FIXTURES_CONTENT_DIR }, "quizmaster")).toThrow(SeedGuardError);
    expect(() => assertTargetDatabase("dev", "quizmaster_dev", "t2609301812_ab12cd_")).toThrow(/Präfixe/);
    expect(() => assertTargetDatabase("prod", "quizmaster_dev", undefined)).toThrow(/_dev/);
    expect(() => assertProdConfirmed("prod", false)).toThrow(/--confirm-prod/);
    expect(() => assertProdConfirmed("prod", true)).not.toThrow();
    await expect(
      runSeed(t.client.db("quizmaster"), {
        env: "prod",
        contentDir: FIXTURES_CONTENT_DIR,
        dryRun: true,
        allowMassRetire: false,
      }),
    ).rejects.toThrow(/Produktion/);
  });

  it("CLI bricht vor jeder Verbindung ab (prod ohne Bestätigung, Fixtures gegen prod)", {
    timeout: 60_000,
  }, async () => {
    const withoutConfirm = await seedCli(["--env", "prod", "--dry-run"]);
    expect(withoutConfirm.code).toBe(1);
    expect(withoutConfirm.output).toContain("--confirm-prod");
    const fixtures = await seedCli([
      "--env",
      "prod",
      "--confirm-prod",
      "--content-dir",
      FIXTURES_CONTENT_DIR,
      "--dry-run",
    ]);
    expect(fixtures.code).toBe(1);
    expect(fixtures.output).toContain("Fixtures dürfen nie in Produktion");
    const usage = await seedCli(["--env", "staging"]);
    expect(usage.code).toBe(2);
  });
});
