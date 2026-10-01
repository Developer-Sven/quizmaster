// setup-env.mjs läuft hier als Kopie in einem Temp-Verzeichnis (ROOT = Skriptordner/..) – nie gegen echte Env-Dateien.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = new URL("../setup-env.mjs", import.meta.url);
const EXAMPLE = [
  "# Vorlage",
  "QUIZMASTER_DOMAIN=localhost",
  "SESSION_SECRET=",
  "METRICS_TOKEN=",
  "TURNSTILE_ENABLED=false",
  "SEARCH_INDEXING=false",
  "LOG_LEVEL=info",
  "MONGODB_URI=",
  "",
].join("\n");

let root: string;

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [join(root, "scripts/setup-env.mjs"), ...args], { encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function envFile(): string {
  return readFileSync(join(root, ".env.dev"), "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qm-setup-env-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(SCRIPT, join(root, "scripts/setup-env.mjs"));
  writeFileSync(join(root, ".env.dev.example"), EXAMPLE);
  expect(run("dev").status).toBe(0);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("setup-env.mjs", () => {
  it("legt die Datei mit Rechten 600 und erzeugten Secrets an, ohne Werte auszugeben", () => {
    const content = envFile();
    const secret = /^SESSION_SECRET=(.+)$/m.exec(content)?.[1] ?? "";
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(join(root, ".env.dev")).mode & 0o777).toBe(0o600);
    expect(run("dev").out).toContain("wird nicht überschrieben");
    expect(envFile()).toBe(content);
  });

  it("--set legt erlaubte Schalter um und lässt alle anderen Zeilen unverändert", () => {
    const before = envFile().split("\n");
    const result = run("dev", "--set", "TURNSTILE_ENABLED=true", "--set", "LOG_LEVEL=warn");
    expect(result.status).toBe(0);
    const after = envFile().split("\n");
    expect(after).toHaveLength(before.length);
    for (const [index, line] of after.entries()) {
      if (line.startsWith("TURNSTILE_ENABLED=")) expect(line).toBe("TURNSTILE_ENABLED=true");
      else if (line.startsWith("LOG_LEVEL=")) expect(line).toBe("LOG_LEVEL=warn");
      else expect(line).toBe(before[index]);
    }
    expect(statSync(join(root, ".env.dev")).mode & 0o777).toBe(0o600);
    const secret = /^SESSION_SECRET=(.+)$/m.exec(envFile())?.[1] ?? "";
    expect(result.out).not.toContain(secret);
    expect(result.out).toContain("TURNSTILE_ENABLED=true");
    expect(run("dev", "--set", "TURNSTILE_ENABLED=true").out).toContain("unverändert");
  });

  it.each([
    [["--set", "SESSION_SECRET=abc"], "kein Schalter"],
    [["--set", "MONGODB_URI=mongodb://x"], "kein Schalter"],
    [["--set", "TURNSTILE_ENABLED=yes"], "erlaubt nur"],
    [["--set", "LOG_LEVEL=verbose"], "erlaubt nur"],
    [["--set", "TURNSTILE_ENABLED"], "KEY=WERT"],
    [["--set", "SEARCH_INDEXING=true", "--set", "SEARCH_INDEXING=false"], "mehrfach"],
    [["--set", "SEARCH_INDEXING=true", "--rotate", "SESSION_SECRET"], "nur einzeln"],
  ])("lehnt %j ab und lässt die Datei unverändert", (args, message) => {
    const before = envFile();
    const result = run("dev", ...args);
    expect(result.status).toBe(1);
    expect(result.out).toContain(message);
    expect(envFile()).toBe(before);
  });

  it("--set bricht ab, wenn der Schalter in der Datei fehlt", () => {
    writeFileSync(join(root, ".env.dev"), "LOG_LEVEL=info\n", { mode: 0o600 });
    const result = run("dev", "--set", "SEARCH_INDEXING=true");
    expect(result.status).toBe(1);
    expect(result.out).toContain("--add-missing");
    expect(envFile()).toBe("LOG_LEVEL=info\n");
  });
});
