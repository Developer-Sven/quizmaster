import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { backupReason, SCHEMA_PATHS } from "./db-backup.ts";
import { changedPaths } from "./git.ts";

describe("backupReason", () => {
  it("sichert beim ersten Release, bei geänderten Schema-Dateien und wenn der Vergleich scheitert", () => {
    expect(backupReason(null, [])).toBe("erstes Release");
    expect(backupReason("a".repeat(40), null)).toContain("nicht möglich");
    expect(backupReason("a".repeat(40), ["packages/db/src/indexes.ts"])).toBe(
      "Schema-Dateien geändert: packages/db/src/indexes.ts",
    );
    expect(backupReason("a".repeat(40), ["a", "b", "c", "d", "e"])).toBe("Schema-Dateien geändert: a, b, c (+2)");
    expect(backupReason("a".repeat(40), [])).toBeNull();
  });

  it("die überwachten Schema-Dateien existieren (Umbenennung würde die Sicherung still abschalten)", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const existing = SCHEMA_PATHS.filter((path) => existsSync(join(root, path)));
    // scripts/migrations entsteht erst mit der ersten Migration (docs/04).
    expect(existing).toEqual(SCHEMA_PATHS.filter((path) => path !== "scripts/migrations"));
  });
});

describe("changedPaths", () => {
  const repo = mkdtempSync(join(tmpdir(), "qm-changed-test-"));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      encoding: "utf8",
    }).trim();

  it("liefert nur geänderte Dateien innerhalb der Pfade, null bei unbekanntem Commit", async () => {
    git("init", "-q");
    mkdirSync(join(repo, "packages", "db", "src"), { recursive: true });
    mkdirSync(join(repo, "apps"), { recursive: true });
    writeFileSync(join(repo, "packages", "db", "src", "indexes.ts"), "v1\n");
    writeFileSync(join(repo, "apps", "page.tsx"), "v1\n");
    git("add", ".");
    git("commit", "-q", "-m", "eins");
    const first = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "apps", "page.tsx"), "v2\n");
    git("commit", "-q", "-am", "zwei");
    const second = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "packages", "db", "src", "indexes.ts"), "v2\n");
    git("commit", "-q", "-am", "drei");
    const third = git("rev-parse", "HEAD");

    expect(await changedPaths(repo, first, second, SCHEMA_PATHS)).toEqual([]);
    expect(await changedPaths(repo, second, third, SCHEMA_PATHS)).toEqual(["packages/db/src/indexes.ts"]);
    // Rollback-Richtung ebenso.
    expect(await changedPaths(repo, third, first, SCHEMA_PATHS)).toEqual(["packages/db/src/indexes.ts"]);
    expect(await changedPaths(repo, first, "f".repeat(40), SCHEMA_PATHS)).toBeNull();
    expect(await changedPaths(repo, "--output=/tmp/x", first, SCHEMA_PATHS)).toBeNull();
  });
});
