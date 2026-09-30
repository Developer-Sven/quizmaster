import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_NOTE } from "./fixtures.ts";
import { FixtureTargetError, fixtureTargetProblem, writeFixtures } from "./fixtures-io.ts";
import { DEFAULT_CONTENT_DIR, FIXTURES_CONTENT_DIR, REPO_ROOT } from "./paths.ts";

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "qm-fixtures-io-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Legt einen Katalog-Ordner an (categories.json mit `note` + eine Themen-Datei). */
function catalogDir(name: string, note: string): { dir: string; categories: string; topic: string } {
  const dir = join(workDir, name);
  mkdirSync(join(dir, "questions", "rund-um-die-welt"), { recursive: true });
  const categories = join(dir, "categories.json");
  writeFileSync(categories, `${JSON.stringify({ note, categories: [] })}\n`);
  const topic = join(dir, "questions", "rund-um-die-welt", "hauptstaedte.json");
  writeFileSync(topic, '{"category":"rund-um-die-welt","topic":"hauptstaedte","questions":[]}\n');
  return { dir, categories, topic };
}

describe("writeFixtures – Schutz des Zielordners", () => {
  it("verweigert einen Ordner mit echtem Katalog und lässt alle Dateien unangetastet", () => {
    const real = catalogDir("echt", "Fragenkatalog Stand 30.09.2026");
    const before = readFileSync(real.categories, "utf8");
    expect(() => writeFixtures(real.dir)).toThrow(FixtureTargetError);
    expect(existsSync(real.topic)).toBe(true);
    expect(readFileSync(real.categories, "utf8")).toBe(before);
  });

  it("verweigert nicht leere Ordner ohne categories.json und unlesbare categories.json", () => {
    const other = join(workDir, "anderes");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "notizen.txt"), "wichtig\n");
    expect(fixtureTargetProblem(other)).toMatch(/kein Fixture-Katalog/);
    expect(() => writeFixtures(other)).toThrow(FixtureTargetError);
    expect(existsSync(join(other, "notizen.txt"))).toBe(true);

    const broken = join(workDir, "kaputt");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "categories.json"), "{ kein json");
    expect(fixtureTargetProblem(broken)).toMatch(/categories\.json/);
  });

  it("verweigert den privaten Katalog content/, Ordner darin und Ordner darüber – auch über Symlinks", () => {
    expect(fixtureTargetProblem(DEFAULT_CONTENT_DIR)).toMatch(/privaten Katalog/);
    expect(fixtureTargetProblem(join(DEFAULT_CONTENT_DIR, "questions", "neu"))).toMatch(/privaten Katalog/);
    expect(fixtureTargetProblem(REPO_ROOT)).toMatch(/privaten Katalog/);

    const privateDir = catalogDir("privat", FIXTURE_NOTE).dir; // selbst mit Markierung: nie dorthin
    const link = join(workDir, "link-auf-privat");
    symlinkSync(privateDir, link);
    const options = { privateContentDir: privateDir };
    expect(fixtureTargetProblem(privateDir, options)).toMatch(/privaten Katalog/);
    expect(fixtureTargetProblem(link, options)).toMatch(/privaten Katalog/);
    expect(fixtureTargetProblem(join(link, "unterordner", "neu"), options)).toMatch(/privaten Katalog/);
  });

  it("erlaubt test/fixtures/content, fehlende und leere Ordner sowie bereits markierte Fixture-Kataloge", () => {
    expect(fixtureTargetProblem(FIXTURES_CONTENT_DIR)).toBeNull();
    expect(fixtureTargetProblem(join(workDir, "gibt-es-nicht", "neu"))).toBeNull();
    const empty = join(workDir, "leer");
    mkdirSync(empty, { recursive: true });
    expect(fixtureTargetProblem(empty)).toBeNull();
    expect(fixtureTargetProblem(catalogDir("markiert", FIXTURE_NOTE).dir)).toBeNull();
  });
});
