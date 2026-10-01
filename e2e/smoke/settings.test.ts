import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chromiumArgs,
  isPlayEnabled,
  OUTPUT_MARKER,
  parseSmokeSettings,
  prepareOutputDir,
  SmokeSettingsError,
} from "./settings.ts";

const DEFAULTS = { outputDir: "/repo/e2e/smoke-results", cwd: "/repo" };

function parse(env: Record<string, string | undefined>) {
  return parseSmokeSettings(env, DEFAULTS);
}

describe("parseSmokeSettings", () => {
  it("verlangt SMOKE_BASE_URL", () => {
    expect(() => parse({})).toThrow(SmokeSettingsError);
    expect(() => parse({ SMOKE_BASE_URL: "  " })).toThrow(/SMOKE_BASE_URL fehlt/);
  });

  it("nimmt nur http(s)-Origins ohne Pfad, Query, Fragment und Zugangsdaten", () => {
    expect(() => parse({ SMOKE_BASE_URL: "quizmaster.dev-sven.de" })).toThrow(/keine gültige URL/);
    expect(() => parse({ SMOKE_BASE_URL: "ftp://example.org" })).toThrow(/http:\/\/ oder https:\/\//);
    expect(() => parse({ SMOKE_BASE_URL: "https://user:geheim@example.org" })).toThrow(/Zugangsdaten/);
    expect(() => parse({ SMOKE_BASE_URL: "https://example.org/lobby" })).toThrow(/ohne Pfad/);
    expect(() => parse({ SMOKE_BASE_URL: "https://example.org/?x=1" })).toThrow(/ohne Pfad/);
  });

  it("meldet nie den eingegebenen Wert (könnte Zugangsdaten enthalten)", () => {
    try {
      parse({ SMOKE_BASE_URL: "https://user:geheim@example.org" });
      expect.unreachable("SmokeSettingsError erwartet");
    } catch (error) {
      expect(error).toBeInstanceOf(SmokeSettingsError);
      expect((error as Error).message).not.toContain("geheim");
    }
  });

  it("normalisiert auf die Origin und übernimmt Standards", () => {
    expect(parse({ SMOKE_BASE_URL: "https://Quizmaster.dev-sven.de/" })).toEqual({
      baseUrl: "https://quizmaster.dev-sven.de",
      hostname: "quizmaster.dev-sven.de",
      https: true,
      resolveTo: null,
      outputDir: "/repo/e2e/smoke-results",
      play: true,
    });
    expect(parse({ SMOKE_BASE_URL: "http://127.0.0.1:3530" })).toMatchObject({
      baseUrl: "http://127.0.0.1:3530",
      https: false,
    });
  });

  it("prüft SMOKE_RESOLVE_TO: IP-Adresse und Hostname in der URL", () => {
    const base = { SMOKE_BASE_URL: "https://quizmaster.dev-sven.de" };
    expect(parse({ ...base, SMOKE_RESOLVE_TO: "127.0.0.1" }).resolveTo).toBe("127.0.0.1");
    expect(parse({ ...base, SMOKE_RESOLVE_TO: "2001:db8::1" }).resolveTo).toBe("2001:db8::1");
    expect(() => parse({ ...base, SMOKE_RESOLVE_TO: "origin.example" })).toThrow(/IP-Adresse/);
    expect(() => parse({ SMOKE_BASE_URL: "https://203.0.113.7", SMOKE_RESOLVE_TO: "127.0.0.1" })).toThrow(/Hostnamen/);
    expect(() => parse({ SMOKE_BASE_URL: "https://[::1]:8443", SMOKE_RESOLVE_TO: "127.0.0.1" })).toThrow(/Hostnamen/);
  });

  it("löst SMOKE_OUTPUT relativ zum Aufrufverzeichnis auf, absolute Pfade bleiben", () => {
    const base = { SMOKE_BASE_URL: "https://example.org" };
    expect(parse({ ...base, SMOKE_OUTPUT: "reports/smoke-prod" }).outputDir).toBe("/repo/reports/smoke-prod");
    expect(parse({ ...base, SMOKE_OUTPUT: "/srv/smoke" }).outputDir).toBe("/srv/smoke");
  });
});

describe("isPlayEnabled", () => {
  it("spielt standardmäßig, SMOKE_PLAY=0 schaltet das Spiel ab, Tippfehler brechen ab", () => {
    expect(isPlayEnabled({})).toBe(true);
    expect(isPlayEnabled({ SMOKE_PLAY: "1" })).toBe(true);
    expect(isPlayEnabled({ SMOKE_PLAY: " 0 " })).toBe(false);
    expect(() => isPlayEnabled({ SMOKE_PLAY: "nein" })).toThrow(/SMOKE_PLAY/);
  });
});

describe("chromiumArgs", () => {
  it("ohne SMOKE_RESOLVE_TO keine Argumente", () => {
    expect(chromiumArgs({ hostname: "example.org", resolveTo: null })).toEqual([]);
  });

  it("bildet den Host auf die IP ab und ignoriert dann Zertifikatsfehler (auch für den Service Worker)", () => {
    expect(chromiumArgs({ hostname: "quizmaster.dev-sven.de", resolveTo: "127.0.0.1" })).toEqual([
      "--host-resolver-rules=MAP quizmaster.dev-sven.de 127.0.0.1",
      "--ignore-certificate-errors",
    ]);
    expect(chromiumArgs({ hostname: "quizmaster.dev-sven.de", resolveTo: "::1" })[0]).toBe(
      "--host-resolver-rules=MAP quizmaster.dev-sven.de [::1]",
    );
  });
});

describe("prepareOutputDir", () => {
  const roots: string[] = [];
  const tempRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "qm-smoke-"));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("legt einen neuen Ordner an, markiert ihn und hält ihn aus Git heraus", () => {
    const dir = join(tempRoot(), "a", "smoke");
    prepareOutputDir(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toMatch(/^\*$/m);
    expect(readFileSync(join(dir, OUTPUT_MARKER), "utf8")).toContain("Smoke-Test");
  });

  it("nutzt leere und bereits markierte Ordner erneut", () => {
    const empty = tempRoot();
    prepareOutputDir(empty);
    writeFileSync(join(empty, "smoke-report.json"), "{}");
    expect(() => prepareOutputDir(empty)).not.toThrow();
  });

  it("lehnt Ordner mit fremdem Inhalt ab (Playwright leert artifacts/ und html/)", () => {
    const foreign = tempRoot();
    mkdirSync(join(foreign, "html"));
    writeFileSync(join(foreign, "html", "index.html"), "<p>fremd</p>");
    expect(() => prepareOutputDir(foreign)).toThrow(/fremdem Inhalt/);
  });

  it("lehnt eine Datei als Ausgabeordner ab", () => {
    const file = join(tempRoot(), "datei");
    writeFileSync(file, "x");
    expect(() => prepareOutputDir(file)).toThrow(/kein Ordner/);
  });
});
