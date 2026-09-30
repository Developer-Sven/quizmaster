/**
 * ADR-023 (Laufzeit- statt Build-Konfiguration): `NEXT_PUBLIC_*` ist verboten. Next.js inlined solche Werte
 * beim Build ins öffentlich ausgelieferte JS – und die gemeinsame Env-Datei je Umgebung (ADR-022) enthält
 * Secrets. Öffentliche Werte (REALTIME_URL, TURNSTILE_SITE_KEY) liest der Server zur Laufzeit und gibt sie
 * als Props weiter. Läuft mit `pnpm test` auch in der CI.
 *
 * Geprüft werden Code-, Konfigurations- und Env-Dateien, die git kennt (getrackt oder neu, ohne ignorierte);
 * Markdown und Workflows nicht (dort landet nichts im Bundle – ein CI-Wächter darf das Präfix nennen).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SELF = relative(ROOT, import.meta.filename)
  .split("\\")
  .join("/");
const FORBIDDEN = ["NEXT", "PUBLIC", ""].join("_");
const SCANNED = /\.(?:[cm]?[jt]sx?|json)$/;

function candidateFiles(): string[] | null {
  try {
    const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\0").filter((file) => file !== "");
  } catch {
    return null;
  }
}

const files = candidateFiles();

describe("ADR-023: kein NEXT_PUBLIC_ (Werte würden ins Client-Bundle inlined)", () => {
  it.skipIf(files === null)("keine Code-, Konfigurations- oder Env-Datei nutzt das Präfix", () => {
    const hits = (files ?? []).filter((file) => {
      if (file === SELF) return false;
      if (!SCANNED.test(file) && !basename(file).startsWith(".env")) return false;
      const path = join(ROOT, file);
      return existsSync(path) && readFileSync(path, "utf8").includes(FORBIDDEN);
    });
    expect(hits, "Wert serverseitig zur Laufzeit lesen und als Prop übergeben (ADR-023)").toEqual([]);
  });

  it("die Next-Konfiguration setzt keinen `env`-Key (würde ebenfalls ins Bundle inlined)", () => {
    for (const name of ["next.config.ts", "next.config.mjs", "next.config.js"]) {
      const path = join(ROOT, "apps", "web", name);
      if (!existsSync(path)) continue;
      expect(/(?:^|[{,])\s*env\s*:/m.test(readFileSync(path, "utf8")), name).toBe(false);
    }
  });
});
