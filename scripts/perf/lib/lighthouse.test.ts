import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  chromeFlags,
  findChromium,
  type LighthouseRun,
  lighthouseArgs,
  medianRun,
  parseReport,
  parseResolve,
  violations,
} from "./lighthouse.ts";

describe("Chromium und Chrome-Flags", () => {
  const root = mkdtempSync(join(tmpdir(), "qm-lh-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  for (const build of ["chromium-1200", "chromium-1243"]) {
    mkdirSync(join(root, build, "chrome-linux64"), { recursive: true });
    writeFileSync(join(root, build, "chrome-linux64", "chrome"), "");
    chmodSync(join(root, build, "chrome-linux64", "chrome"), 0o755);
  }

  it("nimmt CHROME_PATH oder die neueste Playwright-Installation", () => {
    expect(findChromium({ PLAYWRIGHT_BROWSERS_PATH: root })).toBe(
      join(root, "chromium-1243", "chrome-linux64", "chrome"),
    );
    const own = join(root, "chromium-1200", "chrome-linux64", "chrome");
    expect(findChromium({ CHROME_PATH: own, PLAYWRIGHT_BROWSERS_PATH: root })).toBe(own);
    expect(findChromium({ PLAYWRIGHT_BROWSERS_PATH: join(root, "fehlt") })).toBeNull();
  });

  it("baut Host-Auflösung und Zertifikats-Flag nur mit gültigen Werten", () => {
    expect(parseResolve("Quiz.Example.de=203.0.113.7")).toEqual({ host: "quiz.example.de", ip: "203.0.113.7" });
    expect(parseResolve("quiz.example=2001:db8::1")).toEqual({ host: "quiz.example", ip: "[2001:db8::1]" });
    for (const bad of ["quiz.example", "quiz.example=999.1.1.1", "a b=1.2.3.4", "x=1.2.3.4;rm"]) {
      expect(() => parseResolve(bad), bad).toThrow();
    }
    const flags = chromeFlags({ resolve: { host: "quiz.example", ip: "203.0.113.7" }, insecure: true });
    expect(flags).toContain("--headless=new");
    expect(flags).toContain("--no-sandbox");
    expect(flags).toContain("--host-resolver-rules=MAP quiz.example 203.0.113.7");
    expect(flags).toContain("--ignore-certificate-errors");
    expect(chromeFlags({ resolve: null, insecure: false })).not.toContain("--ignore-certificate-errors");
    const args = lighthouseArgs("https://quiz.example/", "/tmp/x/start-1", { resolve: null, insecure: false });
    expect(args).toContain("--only-categories=performance,accessibility,best-practices");
    expect(args).toContain("--output-path=/tmp/x/start-1");
  });
});

describe("Berichte auswerten", () => {
  const report = (performance: number, extra: Record<string, unknown> = {}) => ({
    finalDisplayedUrl: "http://127.0.0.1:3520/j/ABC234",
    categories: {
      performance: { score: performance, auditRefs: [] },
      accessibility: { score: 1, auditRefs: [{ id: "color-contrast", weight: 7 }] },
      "best-practices": { score: 0.96, auditRefs: [{ id: "errors-in-console", weight: 1 }] },
    },
    audits: {
      "largest-contentful-paint": { numericValue: 1_650 },
      "cumulative-layout-shift": { numericValue: 0.01 },
      "total-blocking-time": { numericValue: 120 },
      "first-contentful-paint": { numericValue: 900 },
      "speed-index": { numericValue: 1_100 },
      "color-contrast": { score: 1, scoreDisplayMode: "binary" },
      "errors-in-console": { score: 0, scoreDisplayMode: "binary" },
    },
    ...extra,
  });

  it("liest Scores, LCP/CLS/TBT und nicht bestandene Audits", () => {
    const run = parseReport("Lobby", "http://127.0.0.1:3520/lobby/ABC234", report(0.93), "/x.json");
    expect(run.scores).toEqual({ performance: 0.93, accessibility: 1, "best-practices": 0.96 });
    expect(run).toMatchObject({ lcpMs: 1_650, cls: 0.01, tbtMs: 120, fcpMs: 900, runtimeError: null });
    expect(run.failedAudits).toEqual(["best-practices: errors-in-console"]);
    expect(violations(run)).toEqual([]);
  });

  it("nimmt den Median-Lauf nach Performance und meldet Unterschreitungen", () => {
    const runs: LighthouseRun[] = [0.95, 0.82, 0.91].map((score) => parseReport("Start", "u", report(score), null));
    expect(medianRun(runs)?.scores.performance).toBe(0.91);
    const failed = parseReport("Start", "u", report(0.85), null);
    expect(violations(failed)).toEqual(["Start: performance 85 < 90"]);
    const broken = parseReport("Start", "u", { runtimeError: { code: "NO_FCP" } }, null);
    expect(violations(broken)[0]).toBe("Start: Lighthouse-Fehler NO_FCP");
    expect(medianRun([broken])).toBe(broken);
  });
});
