/**
 * `pnpm content:calibrate` (docs/08 §5, §8): Vorschläge aus der Trefferquote (Grenzen in packages/db getestet),
 * Prüf-Queue unter 10 %, `--apply` mit minimalem Diff im Format „eine Frage pro Zeile“ (nur die Ziffer ändert
 * sich), Überspringen geänderter Fassungen und gemeldeter Fragen, Übernahme durch den Seed.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositories, type Repositories } from "@quizmaster/db";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyCalibration,
  CalibrateFileError,
  CalibrateUsageError,
  formatCalibration,
  locateDifficulties,
  parseCalibrateArgs,
  planCalibration,
  rewriteDifficulties,
} from "./calibrate.ts";
import { FIXTURES_CONTENT_DIR } from "./lib/paths.ts";
import { runSeed } from "./lib/seed-runner.ts";

interface RawFile {
  category: string;
  topic: string;
  questions: Array<Record<string, unknown> & { id: string; difficulty: number }>;
}

/** Themen-Datei im Content-Format (docs/08 §3): eine Frage pro Zeile, kompaktes JSON. */
function toLineFormat(file: RawFile): string {
  const lines = file.questions.map(
    (question, index) => `    ${JSON.stringify(question)}${index < file.questions.length - 1 ? "," : ""}`,
  );
  return `{\n  "category": ${JSON.stringify(file.category)},\n  "topic": ${JSON.stringify(file.topic)},\n  "questions": [\n${lines.join("\n")}\n  ]\n}\n`;
}

const SAMPLE: RawFile = {
  category: "rund-um-die-welt",
  topic: "hauptstaedte",
  questions: [
    {
      id: "rw-aaaaaaa1",
      difficulty: 2,
      prompt: 'Welches Feld heißt in JSON "difficulty":5 – und was ist die Hauptstadt von Frankreich?',
      answers: ["Paris", "Lyon", "Marseille", "Nizza"],
      status: "unverified",
    },
    {
      id: "rw-aaaaaaa2",
      difficulty: 3,
      prompt: "Was ist die Hauptstadt von Ägypten?",
      answers: ["Kairo", "Alexandria", "Gizeh", "Luxor"],
      status: "unverified",
      explanation: 'Ein \\ Backslash und ein "Zitat" im Text.',
    },
    {
      id: "rw-aaaaaaa3",
      difficulty: 4,
      prompt: "Was ist die Hauptstadt von Kanada?",
      answers: ["Ottawa", "Toronto", "Montreal", "Vancouver"],
      status: "unverified",
    },
  ],
};

describe("Argumente", () => {
  it("Standard dev, --min-shown 30, ohne --apply", () => {
    expect(parseCalibrateArgs([])).toMatchObject({ env: "dev", minShown: 30, apply: false, help: false });
    expect(parseCalibrateArgs(["--env", "prod", "--min-shown", "50", "--apply"])).toMatchObject({
      env: "prod",
      minShown: 50,
      apply: true,
    });
    for (const bad of [
      ["--min-shown", "0"],
      ["--min-shown", "2.5"],
      ["--min-shown", "x"],
      ["--env", "test"],
      ["foo"],
    ]) {
      expect(() => parseCalibrateArgs(bad), bad.join(" ")).toThrow(CalibrateUsageError);
    }
  });
});

describe("Schwierigkeit in der Datei finden und ändern", () => {
  it("findet den Wert je Frage – im Zeilenformat, eingerückt und trotz „difficulty“ in Strings", () => {
    const text = toLineFormat(SAMPLE);
    const spans = locateDifficulties(text);
    expect([...spans.keys()]).toEqual(["rw-aaaaaaa1", "rw-aaaaaaa2", "rw-aaaaaaa3"]);
    for (const [id, span] of spans) {
      const expected = SAMPLE.questions.find((question) => question.id === id)?.difficulty;
      expect(text.slice(span.start, span.end)).toBe(String(expected));
    }
    const pretty = JSON.stringify(SAMPLE, null, 2);
    const prettySpans = locateDifficulties(pretty);
    expect(pretty.slice(prettySpans.get("rw-aaaaaaa3")?.start, prettySpans.get("rw-aaaaaaa3")?.end)).toBe("4");
  });

  it("ändert nur die Ziffer in der Zeile der Frage (minimaler Diff), Gegenprobe gegen Schema und Inhalt", () => {
    const text = toLineFormat(SAMPLE);
    const next = rewriteDifficulties(text, new Map([["rw-aaaaaaa1", 5]]));
    const before = text.split("\n");
    const after = next.split("\n");
    expect(after).toHaveLength(before.length);
    const changed = before.flatMap((line, index) => (line === after[index] ? [] : [index]));
    expect(changed).toHaveLength(1);
    const index = changed[0] ?? -1;
    expect(before[index]).toContain('"id":"rw-aaaaaaa1","difficulty":2,');
    expect(after[index]).toBe(before[index]?.replace('"difficulty":2,', '"difficulty":5,'));
    // Der Text „"difficulty":5“ im Fragetext bleibt unangetastet.
    expect(after[index]).toContain('\\"difficulty\\":5 – und');
    expect(JSON.parse(next).questions[0].difficulty).toBe(5);
    expect(() => rewriteDifficulties(text, new Map([["rw-zzzzzzz9", 1]]))).toThrow(CalibrateFileError);
  });

  it("verweigert kaputte Dateien und doppelte IDs", () => {
    expect(() => locateDifficulties('{"questions":[{"id":"rw-aaaaaaa1","difficulty":2}')).toThrow(CalibrateFileError);
    const duplicate = { ...SAMPLE, questions: [SAMPLE.questions[0], SAMPLE.questions[0]] } as RawFile;
    expect(() => locateDifficulties(toLineFormat(duplicate))).toThrow(/doppelt/);
    expect(() => locateDifficulties('{"questions":[{"id":"rw-aaaaaaa1"}]}')).toThrow(/difficulty fehlt/);
  });
});

describe("Kalibrierung gegen die Test-DB", () => {
  let t: TestDatabase;
  let repos: Repositories;
  let contentDir: string;

  beforeAll(async () => {
    t = await createTestDatabase({ ensureIndexes: true });
    repos = createRepositories(t.client, t.collections);
    // Fixtures im echten Content-Format (eine Frage pro Zeile) in einen temporären Ordner schreiben.
    contentDir = mkdtempSync(join(tmpdir(), "qm-calibrate-"));
    writeFileSync(join(contentDir, "categories.json"), readFileSync(join(FIXTURES_CONTENT_DIR, "categories.json")));
    for (const category of readdirSync(join(FIXTURES_CONTENT_DIR, "questions"))) {
      const target = join(contentDir, "questions", category);
      mkdirSync(target, { recursive: true });
      for (const name of readdirSync(join(FIXTURES_CONTENT_DIR, "questions", category))) {
        const raw = JSON.parse(
          readFileSync(join(FIXTURES_CONTENT_DIR, "questions", category, name), "utf8"),
        ) as RawFile;
        writeFileSync(join(target, name), toLineFormat(raw));
      }
    }
    await runSeed(t.db, { env: "dev", contentDir, dryRun: false, allowMassRetire: false, prefix: t.prefix });
  }, 120_000);

  afterAll(async () => {
    if (contentDir) rmSync(contentDir, { recursive: true, force: true });
    await t?.cleanup();
  });

  async function setStats(questionId: string, shown: number, correct: number) {
    await t.collections.questions.updateOne(
      { _id: questionId },
      { $set: { "stats.shown": shown, "stats.correct": correct } },
    );
  }

  it("Vorschläge ab 30 Anzeigen, Prüf-Queue < 10 %, --apply schreibt minimal und der Seed übernimmt", async () => {
    const docs = await t.collections.questions
      .find({ category: "kinofilme", status: "unverified" }, { projection: { _id: 1, topic: 1, difficulty: 1 } })
      .sort({ _id: 1 })
      .toArray();
    const [easy, broken, few, reported, edited] = docs;
    if (!easy || !broken || !few || !reported || !edited) throw new Error("Zu wenige Fixture-Fragen");
    const target = (difficulty: number) => (difficulty === 1 ? 5 : 1);
    // easy: Trefferquote passend zur Gegenstufe (1 ↔ 5), damit sich garantiert etwas ändert.
    await setStats(easy._id, 40, easy.difficulty === 1 ? 4 : 38);
    await setStats(broken._id, 40, 2); // 5 % → Prüf-Queue
    await setStats(few._id, 29, 0); // zu wenige Anzeigen
    await setStats(reported._id, 40, reported.difficulty === 1 ? 4 : 38);
    await setStats(edited._id, 40, edited.difficulty === 1 ? 4 : 38);
    await repos.reports.create(
      { questionId: reported._id, reason: "tippfehler", guestId: randomUUID(), lobbyCode: null, ipKey: null },
      new Date(),
    );
    // edited: im Repo geändert und noch nicht geseedet → Hash weicht ab (nur die Zeile dieser Frage).
    const editedFile = join(contentDir, "questions", "kinofilme", `${edited.topic}.json`);
    const editedLines = readFileSync(editedFile, "utf8").split("\n");
    const editedIndex = editedLines.findIndex((line) => line.includes(`{"id":"${edited._id}",`));
    editedLines[editedIndex] = (editedLines[editedIndex] ?? "").replace('"prompt":"', '"prompt":"Neu: ');
    writeFileSync(editedFile, editedLines.join("\n"));

    const plan = await planCalibration(repos, { minShown: 30, readPreference: "primary" });
    const ids = (list: { questionId: string }[]) => list.map((entry) => entry.questionId);
    expect(ids(plan.changes)).toEqual(expect.arrayContaining([easy._id, reported._id, edited._id]));
    expect(ids(plan.changes)).not.toContain(broken._id);
    expect(ids(plan.review)).toEqual([broken._id]);
    expect([...ids(plan.changes), ...ids(plan.review)]).not.toContain(few._id);
    expect(plan.openReports.has(reported._id)).toBe(true);
    const preview = formatCalibration(plan, null).join("\n");
    expect(preview).toContain(`${broken._id}  kinofilme/`);
    expect(preview).toContain("[offene Meldungen – bei --apply übersprungen]");
    expect(preview).toContain("Nur Vorschau");

    const easyFile = join(contentDir, "questions", "kinofilme", `${easy.topic}.json`);
    const before = readFileSync(easyFile, "utf8");
    const applied = applyCalibration(plan, contentDir);
    expect(ids(applied.applied)).toEqual([easy._id]);
    expect(applied.skipped.map((skip) => [skip.result.questionId, skip.reason]).sort()).toEqual(
      [
        [reported._id, "open_reports"],
        [edited._id, "hash_mismatch"],
      ].sort(),
    );
    const after = readFileSync(easyFile, "utf8");
    const changedLines = before
      .split("\n")
      .map((line, index) => [line, after.split("\n")[index]] as const)
      .filter(([a, b]) => a !== b);
    expect(changedLines).toHaveLength(1);
    const [[oldLine, newLine] = ["", ""]] = changedLines;
    expect(newLine).toBe(
      oldLine.replace(`"difficulty":${easy.difficulty},`, `"difficulty":${target(easy.difficulty)},`),
    );
    expect(formatCalibration(plan, applied).join("\n")).toContain("1 Fragen in 1 Dateien geändert, 2 übersprungen");

    // Seed übernimmt die neue Schwierigkeit (und nur diese Änderung + die bewusst editierte Frage).
    const seeded = await runSeed(t.db, {
      env: "dev",
      contentDir,
      dryRun: false,
      allowMassRetire: false,
      prefix: t.prefix,
    });
    expect(seeded.result.plan.contentUpdates.map((update) => update.id).sort()).toEqual([easy._id, edited._id].sort());
    expect(await t.collections.questions.findOne({ _id: easy._id })).toMatchObject({
      difficulty: target(easy.difficulty),
      version: 2,
    });
    // Zweiter Lauf: nichts mehr zu tun (Statistik passt jetzt zur neuen Schwierigkeit).
    const again = await planCalibration(repos, { minShown: 30, readPreference: "primary" });
    expect(ids(again.changes)).not.toContain(easy._id);
  });
});
