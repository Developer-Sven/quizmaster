import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFlagCodes } from "./flags.ts";
import { indexIdLines } from "./load.ts";
import { DEFAULT_CONTENT_DIR, FIXTURES_CONTENT_DIR } from "./paths.ts";
import { validateContentDir } from "./validate.ts";

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "qm-validate-"));
  cpSync(FIXTURES_CONTENT_DIR, workDir, { recursive: true });
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeTopic(category: string, topic: string, questions: string[], fileCategory = category): string {
  const path = join(workDir, "questions", category, `${topic}.json`);
  const body = `{\n  "category": "${fileCategory}",\n  "topic": "${topic}",\n  "questions": [\n    ${questions.join(",\n    ")}\n  ]\n}\n`;
  writeFileSync(path, body);
  return path;
}

describe("content:validate", () => {
  it("die Fixtures sind fehlerfrei", () => {
    const result = validateContentDir(FIXTURES_CONTENT_DIR);
    expect(result.errors).toBe(0);
    expect(result.catalog.questions.length).toBeGreaterThanOrEqual(19 * 10);
  });

  it.skipIf(!existsSync(DEFAULT_CONTENT_DIR))("der echte Katalog lädt vollständig (216 Dateien)", () => {
    const result = validateContentDir(DEFAULT_CONTENT_DIR);
    expect(result.catalog.files).toHaveLength(216);
    expect(result.catalog.questions.length).toBeGreaterThan(20_000);
  });

  it("findet Regelverstöße mit Datei, Zeile und ID", () => {
    const bad = writeTopic("comics", "grundlagen", [
      '{"id":"co-bad00001","difficulty":1,"prompt":"Fixture-Frage ohne Fragezeichen.","answers":["A","B","C","D"],"status":"unverified"}',
      '{"id":"co-bad00002","difficulty":1,"prompt":"Fixture-Frage mit Sammelantwort?","answers":["Keine davon","B","C","D"],"status":"unverified"}',
      '{"id":"co-bad00003","difficulty":1,"prompt":"Fixture-Frage mit Doppelten?","answers":["Paris","paris","C","D"],"status":"unverified"}',
      '{"id":"kf-bad00004","difficulty":2,"prompt":"Fixture-Frage mit falschem Kürzel?","answers":["A","B","C","D"],"status":"unverified"}',
      '{"id":"co-bad00005","difficulty":2,"prompt":"Fixture-Frage mit Flagge?","media":{"kind":"flag","code":"zz"},"answers":["A","B","C","D"],"status":"unverified"}',
      '{"id":"co-bad00006","difficulty":3,"prompt":"Fixture-Frage belegt ohne Quelle?","answers":["A","B","C","D"],"status":"approved"}',
      '{"id":"co-bad00007","difficulty":3,"prompt":"Fixture-Zahlen ohne Zahlen?","answers":["eins","zwei","drei","vier"],"displayOrder":"asc","status":"unverified"}',
      '{"id":"co-bad00008","difficulty":3,"prompt":"In welcher Stadt steht Berlin Mitte?","answers":["Berlin","Hamburg","Köln","Bonn"],"status":"unverified"}',
      '{"id":"co-bad00008","difficulty":4,"prompt":"Fixture-Frage mit doppelter ID?","answers":["A","B","C","D"],"status":"unverified"}',
      '{"id":"co-bad00009","difficulty":6,"prompt":"Fixture-Frage mit Stufe sechs?","answers":["A","B","C","D"],"status":"unverified"}',
    ]);
    const result = validateContentDir(workDir, { onlyFiles: [bad] });
    const byCode = (code: string) => result.findings.filter((finding) => finding.code === code);
    expect([...new Set(byCode("question-schema").map((f) => f.questionId))].sort()).toEqual([
      "co-bad00001",
      "co-bad00006",
      "co-bad00009",
    ]);
    expect(
      byCode("question-schema")
        .map((f) => f.message)
        .join("\n"),
    ).toMatch(/approved braucht source/);
    expect(byCode("forbidden-answer").map((f) => f.questionId)).toEqual(["co-bad00002"]);
    expect(byCode("answers-not-unique").map((f) => f.questionId)).toEqual(["co-bad00003"]);
    expect(byCode("id-prefix").map((f) => f.questionId)).toEqual(["kf-bad00004"]);
    expect(byCode("flag-code").map((f) => f.questionId)).toEqual(["co-bad00005"]);
    expect(byCode("duplicate-id").map((f) => f.questionId)).toEqual(["co-bad00008"]);
    expect(byCode("asc-not-numeric").every((f) => f.severity === "warning")).toBe(true);
    expect(byCode("answer-in-prompt").map((f) => f.questionId)).toEqual(["co-bad00008"]);
    const flag = byCode("flag-code")[0];
    expect(flag?.line).toBe(9);
    expect(flag?.file).toMatch(/questions\/comics\/grundlagen\.json$/);
    expect(result.errors).toBeGreaterThanOrEqual(8);
  });

  it("prüft Ablage, Kategorie und Thema gegen categories.json", () => {
    const wrongPlace = writeTopic(
      "kinofilme",
      "grundlagen",
      [
        '{"id":"co-place001","difficulty":1,"prompt":"Fixture-Frage am falschen Ort?","answers":["A","B","C","D"],"status":"unverified"}',
      ],
      "comics",
    );
    const unknownTopic = writeTopic("comics", "gibtsnicht", [
      '{"id":"co-topic001","difficulty":1,"prompt":"Fixture-Frage ohne Thema?","answers":["A","B","C","D"],"status":"unverified"}',
    ]);
    const result = validateContentDir(workDir, { onlyFiles: [wrongPlace, unknownTopic] });
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["path-mismatch", "unknown-topic"]),
    );
  });

  it("meldet kaputtes JSON statt abzustürzen", () => {
    const path = join(workDir, "questions", "comics", "kaputt.json");
    writeFileSync(path, "{ nicht json");
    const result = validateContentDir(workDir, { onlyFiles: [path] });
    expect(result.findings.map((finding) => finding.code)).toEqual(["json-parse"]);
  });

  it("kennt alle Flaggen-Codes aus flag-icons (inkl. Sonderformen)", () => {
    const codes = loadFlagCodes();
    for (const code of ["de", "gb-eng", "eu", "un", "es-ct"]) expect(codes.has(code), code).toBe(true);
    expect(codes.has("zz")).toBe(false);
  });

  it("findet Zeilennummern je ID (eine Frage pro Zeile)", () => {
    const raw = readFileSync(join(FIXTURES_CONTENT_DIR, "questions", "comics", "zahlen.json"), "utf8");
    expect([...indexIdLines(raw).values()].every((line) => line > 0)).toBe(true);
  });
});
