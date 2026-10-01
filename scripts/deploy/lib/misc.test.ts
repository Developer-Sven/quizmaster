import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeReleaseModes, verifySelfContained } from "./build.ts";
import { parsePorcelainZ } from "./git.ts";
import { expectedChecksum } from "./runtime.ts";

describe("parsePorcelainZ", () => {
  it("liefert geänderte und neue Pfade, bei Umbenennungen nur den neuen", () => {
    const output = [" M package.json", "?? infra/caddy/new.txt", "R  new-name.ts", "old-name.ts", ""].join("\0");
    expect(parsePorcelainZ(output)).toEqual(["package.json", "infra/caddy/new.txt", "new-name.ts"]);
    expect(parsePorcelainZ("")).toEqual([]);
  });
});

describe("expectedChecksum", () => {
  it("findet den Hash einer Datei in SHASUMS256.txt", () => {
    const hash = "f".repeat(64);
    const sums = `${"a".repeat(64)}  node-v24.21.0-darwin-arm64.tar.gz\n${hash}  node-v24.21.0-linux-x64.tar.xz\n`;
    expect(expectedChecksum(sums, "node-v24.21.0-linux-x64.tar.xz")).toBe(hash);
    expect(expectedChecksum(sums, "node-v24.21.0-linux-x64.tar.gz")).toBeNull();
  });
});

describe("verifySelfContained", () => {
  const dirs: string[] = [];
  const release = () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-release-test-"));
    dirs.push(dir);
    mkdirSync(join(dir, "node_modules", ".pnpm", "pkg@1.0.0"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".pnpm", "pkg@1.0.0", "index.js"), "");
    symlinkSync(join(".pnpm", "pkg@1.0.0"), join(dir, "node_modules", "pkg"));
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("akzeptiert relative Symlinks innerhalb des Releases", () => {
    expect(verifySelfContained(release())).toEqual({ files: 1, links: 1 });
  });

  it("normalizeReleaseModes: 755/644, keine Schreibrechte für Gruppe/andere, kein setuid, Symlinks unberührt", () => {
    const dir = release();
    const target = join(dir, "outside-target");
    writeFileSync(target, "x");
    chmodSync(target, 0o600);
    symlinkSync(target, join(dir, "link"));
    mkdirSync(join(dir, "bin"));
    chmodSync(join(dir, "bin"), 0o700);
    const files: Array<[string, number, number]> = [
      [join(dir, "app.js"), 0o664, 0o644],
      [join(dir, "bin", "tool"), 0o700, 0o755],
      [join(dir, "bin", "suid"), 0o4755, 0o755],
      [join(dir, "node_modules", ".pnpm", "pkg@1.0.0", "index.js"), 0o640, 0o644],
    ];
    for (const [path, mode] of files) {
      writeFileSync(path, "x");
      chmodSync(path, mode);
    }
    // Dazu kommen die Wurzel (mkdtemp: 700), bin (700) und outside-target (600); Symlinks werden nicht verfolgt.
    expect(normalizeReleaseModes(dir)).toBe(files.length + 3);
    for (const [path, , wanted] of files) expect(statSync(path).mode & 0o7777).toBe(wanted);
    expect(statSync(join(dir, "bin")).mode & 0o7777).toBe(0o755);
    expect(lstatSync(join(dir, "link")).isSymbolicLink()).toBe(true);
    expect(normalizeReleaseModes(dir)).toBe(0);
  });

  it("lehnt absolute, herausführende und defekte Symlinks ab", () => {
    const absolute = release();
    symlinkSync("/etc/hostname", join(absolute, "abs"));
    expect(() => verifySelfContained(absolute)).toThrow(/absoluter Symlink/);

    const escaping = release();
    symlinkSync("../../outside", join(escaping, "node_modules", "escape"));
    expect(() => verifySelfContained(escaping)).toThrow(/aus dem Release heraus/);

    const broken = release();
    symlinkSync("missing", join(broken, "broken"));
    expect(() => verifySelfContained(broken)).toThrow(/defekter Symlink/);
  });
});
