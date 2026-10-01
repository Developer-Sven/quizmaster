import { describe, expect, it } from "vitest";
import type { ColdStartResult } from "./cold-start.ts";
import {
  type AxeSection,
  type BrowserSection,
  buildSmokeReport,
  type CollectedTest,
  formatSmokeReport,
  type GameSection,
  purgeCommand,
  type SmokeReportInput,
} from "./report.ts";
import { collectTest, displayPath } from "./reporter.ts";

const COLD: ColdStartResult = {
  code: "ABC234",
  openToLobbyMs: 4_540,
  sloMs: 10_000,
  ttfbMs: 80,
  fcpMs: 770,
  lcpMs: 770,
  lcpSloMs: 1_800,
  interactiveMs: 1_780,
  transferredKb: 248,
  clickMs: 1_930,
  createToLobbyMs: 2_610,
  throttling: { latencyMs: 150, downloadKbitPerSecond: 1_600, uploadKbitPerSecond: 750, cpuSlowdown: 4 },
};

const GAME: GameSection = {
  code: "ABC234",
  played: true,
  skipReason: null,
  rounds: 1,
  questionsPerCategory: 1,
  durationMs: 41_200,
  players: [
    {
      name: "Smoke Mia",
      device: "Pixel 7",
      host: true,
      finished: true,
      picks: 1,
      answers: 2,
      missedAnswers: 0,
      headline: "Gewonnen",
      left: true,
    },
    {
      name: "Smoke Ben",
      device: "iPhone 15",
      host: false,
      finished: true,
      picks: 1,
      answers: 1,
      missedAnswers: 1,
      headline: "Verloren",
      left: true,
    },
  ],
};

const AXE: AxeSection = {
  screen: "lobby-host",
  person: "Smoke Mia",
  device: "Pixel 7",
  violations: [{ id: "color-contrast", impact: "serious", help: "Kontrast zu gering", targets: ["p"] }],
  incomplete: 0,
  passes: 38,
  layout: [],
  screenshot: "artifacts/x/screens/lobby-host.png",
};

const BROWSER: BrowserSection = {
  messages: 3,
  problems: [{ kind: "csp", page: "Smoke Mia (Pixel 7)", text: "Refused to load the script" }],
  console: ["[Smoke Mia (Pixel 7)] error: Refused to load the script"],
};

function input(tests: CollectedTest[], status: SmokeReportInput["status"] = "failed"): SmokeReportInput {
  return {
    baseUrl: "https://quizmaster.dev-sven.de",
    resolveTo: "127.0.0.1",
    play: true,
    startedAt: new Date("2026-10-01T08:00:00.000Z"),
    finishedAt: new Date("2026-10-01T08:01:05.000Z"),
    status,
    tests,
    globalErrors: [],
    files: { json: "e2e/smoke-results/smoke-report.json", text: "t", html: "h", artifacts: "a" },
  };
}

const FLOW: CollectedTest = {
  title: "Kaltstart unter Slow 4G, Beitritt per Link, Spiel zu zweit, axe",
  status: "failed",
  durationMs: 61_000,
  errors: ["Error: lobby-host: axe-Befunde\n\nExpected: []"],
  sections: [
    { name: "lobby", data: { code: "ABC234", createdAt: "2026-10-01T08:00:05.000Z" } },
    { name: "cold-start", data: COLD },
    { name: "axe", data: AXE },
    { name: "game", data: GAME },
    { name: "browser", data: BROWSER },
    { name: "pwa", data: { error: "Anhang nicht lesbar" } },
  ],
};

describe("buildSmokeReport", () => {
  it("fasst Abschnitte zusammen und nennt die Lobby-Codes für die Bereinigung", () => {
    const report = buildSmokeReport(input([FLOW]));
    expect(report.durationMs).toBe(65_000);
    expect(report.coldStart).toEqual(COLD);
    expect(report.game).toEqual(GAME);
    expect(report.axe).toEqual([AXE]);
    // Unlesbare/fremde Abschnitte fallen weg statt den Bericht zu verfälschen.
    expect(report.pwa).toBeNull();
    expect(report.browser.cspViolations).toEqual(["[Smoke Mia (Pixel 7)] Refused to load the script"]);
    expect(report.browser.console).toEqual(BROWSER.console);
    expect(report.cleanup).toEqual({ lobbyCodes: ["ABC234"], commands: [purgeCommand("ABC234")] });
    expect(purgeCommand("ABC234")).toBe("pnpm admin:game purge --code ABC234 --env <env> [--confirm-prod]");
  });

  it("kommt ohne Abschnitte aus (z. B. Abbruch vor dem ersten Test)", () => {
    const report = buildSmokeReport({ ...input([], "interrupted"), globalErrors: ["Error: Worker abgestürzt"] });
    expect(report.coldStart).toBeNull();
    expect(report.cleanup.lobbyCodes).toEqual([]);
    expect(formatSmokeReport(report)).toContain("Bereinigung: keine Lobby angelegt.");
    expect(formatSmokeReport(report)).toContain("[FEHLER]  Error: Worker abgestürzt");
  });

  it("ohne gestartetes Spiel gibt es nichts zu bereinigen", () => {
    const noGame: GameSection = { ...GAME, played: false, skipReason: "SMOKE_PLAY=0", durationMs: null };
    const report = buildSmokeReport(
      input([{ ...FLOW, status: "passed", errors: [], sections: [{ name: "game", data: noGame }] }], "passed"),
    );
    expect(report.cleanup).toEqual({ lobbyCodes: ["ABC234"], commands: [] });
    const text = formatSmokeReport(report);
    expect(text).toContain("kein Spiel (SMOKE_PLAY=0)");
    expect(text).toContain("Bereinigung: nichts zu tun – kein Spiel gestartet (Lobby ABC234).");
  });

  it("Lobby ohne Spielabschnitt (Verlauf unbekannt) bekommt vorsorglich den Bereinigungsbefehl", () => {
    const report = buildSmokeReport(input([{ ...FLOW, sections: [FLOW.sections[0] ?? { name: "x", data: null }] }]));
    expect(report.cleanup.commands).toEqual([purgeCommand("ABC234")]);
  });
});

describe("formatSmokeReport", () => {
  const text = formatSmokeReport(buildSmokeReport(input([FLOW])));

  it("nennt Ergebnis, Ziel, Zeiten und Befunde", () => {
    expect(text).toContain("quizmaster Smoke-Test: NICHT BESTANDEN – 0/1 Prüfungen in 1:05 min");
    expect(text).toContain("Host aufgelöst auf 127.0.0.1, Zertifikatsfehler ignoriert");
    expect(text).toContain("[FEHLER]  Kaltstart unter Slow 4G");
    expect(text).toMatch(/Öffnen → Lobby sichtbar\s+4,54 s\s+Ziel < 10 s \(docs\/01\)\s+OK/);
    expect(text).toMatch(/LCP Startseite\s+0,77 s\s+Ziel < 1,8 s \(docs\/07\)\s+OK/);
    expect(text).toContain("Slow 4G: 150 ms, 1,6/0,75 Mbit/s, CPU 4×");
    expect(text).toContain("Start → Spielende 41,20 s");
    expect(text).toContain("Smoke Ben: Verloren (1 Wahl, 1 Antworten, 1 verpasst)");
    expect(text).toContain("lobby-host: color-contrast (serious) – Kontrast zu gering");
    expect(text).toContain("1 CSP-Verstöße");
    expect(text).toContain("  pnpm admin:game purge --code ABC234 --env <env> [--confirm-prod]");
  });

  it("enthält keine Emojis", () => {
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("markiert verfehlte Ziele", () => {
    const slow = buildSmokeReport(
      input([{ ...FLOW, sections: [{ name: "cold-start", data: { ...COLD, openToLobbyMs: 12_500, lcpMs: null } }] }]),
    );
    const slowText = formatSmokeReport(slow);
    expect(slowText).toMatch(/Öffnen → Lobby sichtbar\s+12,50 s\s+Ziel < 10 s \(docs\/01\)\s+VERFEHLT/);
    expect(slowText).toContain("LCP Startseite           nicht gemessen");
  });
});

describe("displayPath", () => {
  it("zeigt Pfade relativ zum Aufrufverzeichnis, außerhalb absolut", () => {
    expect(displayPath("/repo/e2e/smoke-results/smoke-report.json", "/repo")).toBe(
      "e2e/smoke-results/smoke-report.json",
    );
    expect(displayPath("/tmp/smoke/smoke-report.json", "/repo")).toBe("/tmp/smoke/smoke-report.json");
    expect(displayPath("/repo", "/repo")).toBe(".");
  });
});

describe("collectTest", () => {
  it("übernimmt nur Anhänge smoke:*, ohne Farbcodes in Fehlern, unlesbare Abschnitte als Fehler", () => {
    const collected = collectTest(
      { title: "Startseite" },
      {
        status: "failed",
        duration: 870,
        errors: [{ message: "\u001b[31mError: CSP\u001b[39m" }],
        attachments: [
          { name: "smoke:lobby", contentType: "application/json", body: Buffer.from('{"code":"ABC234"}') },
          { name: "smoke:pwa", contentType: "application/json", body: Buffer.from("{kaputt") },
          { name: "browser-console.txt", contentType: "text/plain", body: Buffer.from("[x] log: y") },
        ],
      },
    );
    expect(collected.sections).toEqual([{ name: "lobby", data: { code: "ABC234" } }]);
    expect(collected.errors[0]).toBe("Error: CSP");
    expect(collected.errors[1]).toMatch(/^Berichtsabschnitt „pwa“ nicht lesbar: /);
    expect(collected.durationMs).toBe(870);
  });
});
