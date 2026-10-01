import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E (docs/11 §E2E-Szenarien): echte Browser (Chromium, ADR-026) mit Mobil-Viewports gegen zwei Test-Stacks.
 *
 * 1. `scripts/dev/stack-test.ts` (= `pnpm stack:test`) baut Realtime und Web, seedet die Test-DB (Präfix je
 *    Lauf, ADR-029) und startet beide mit `GAME_TIMING=fast`, Dev-Bots und gelockerten Limits – Szenarien 1–8,
 *    10 und 11 (Projekte `pixel-7`, `iphone-15`).
 * 2. `e2e/stack/normal-stack.ts` nutzt dieselben Builds mit `GAME_TIMING=normal` und eigener Test-DB, in der
 *    jede Fixture-Frage als Langtext-Variante liegt (140/40 Zeichen) – Szenario 9 (axe + Design-Checks +
 *    Screenshots je Phase, Projekte `a11y-360`/`a11y-430` mit 360 × 740 und 430 × 932) und Szenario 12
 *    (Synchronität, Projekt `sync`: läuft zuletzt und allein, mit Wiederholungen).
 *
 * Beim Ende bekommen beide Stacks SIGTERM und räumen ihre Test-Collections selbst ab.
 *
 * Env: `E2E_WEB_PORT` / `E2E_REALTIME_PORT` (Standard 3200/4200), `E2E_NORMAL_WEB_PORT` /
 * `E2E_NORMAL_REALTIME_PORT` (Standard jeweils +1), `E2E_WORKERS` (1–2, Standard 2), `E2E_OUTPUT_DIR`,
 * `E2E_REUSE_STACK=1` (laufende Stacks mit denselben Ports nutzen), `E2E_NO_BUILD=1` (vorhandene Builds
 * nutzen), `E2E_SCREENSHOT_DIR` (Ablage der Phasen-Screenshots, Standard lokal `docs/screenshots/w3`).
 */
const repoRoot = resolve(import.meta.dirname, "..");
const webPort = Number(process.env.E2E_WEB_PORT ?? 3200);
const realtimePort = Number(process.env.E2E_REALTIME_PORT ?? 4200);
const normalWebPort = Number(process.env.E2E_NORMAL_WEB_PORT ?? webPort + 1);
const normalRealtimePort = Number(process.env.E2E_NORMAL_REALTIME_PORT ?? realtimePort + 1);
const workers = Math.min(2, Math.max(1, Number(process.env.E2E_WORKERS ?? 2)));
const outputDir = resolve(import.meta.dirname, process.env.E2E_OUTPUT_DIR ?? "test-results");
const reuseStack = process.env.E2E_REUSE_STACK === "1";
const stackArgs = [
  `--web-port ${webPort}`,
  `--realtime-port ${realtimePort}`,
  // Logs von Web/Realtime/Builds neben den Test-Artefakten (CI lädt sie bei Fehlern hoch).
  `--log-dir "${resolve(outputDir, "stack-logs")}"`,
  ...(process.env.E2E_NO_BUILD === "1" ? ["--no-build"] : []),
];
const normalStackArgs = [
  `--web-port ${normalWebPort}`,
  `--realtime-port ${normalRealtimePort}`,
  `--log-dir "${resolve(outputDir, "stack-logs-normal")}"`,
];
const normalBaseURL = `http://127.0.0.1:${normalWebPort}`;

/** Specs gegen den Normal-Stack (`GAME_TIMING=normal`). */
const NORMAL_TIMING_SPECS = /(09-a11y|12-sync)\.spec\.ts$/;

/** Mobilgerät (Chromium, Touch) mit festem Viewport für die Design-Abnahme (docs/09 §13). */
function mobileViewport(width: number, height: number) {
  return {
    ...devices["Pixel 7"],
    viewport: { width, height },
    screen: { width, height },
    deviceScaleFactor: 2,
  };
}

export default defineConfig({
  testDir: "./tests",
  outputDir,
  fullyParallel: false,
  workers,
  // Eine Wiederholung auch lokal: Die Test-DB liegt auf dem Dev-Cluster (ADR-029, keine lokale mongod möglich);
  // dessen Verbindung reißt gelegentlich für 20–40 s ab (beobachtet: Pool cleared / secureConnect-Timeout) und
  // beendet dann laufende Spiele mit LOAD_FAILED bzw. Sessions mit 503. Wiederholte Tests erscheinen im Bericht
  // als „flaky“. In der CI (MongoMemoryReplSet) gilt dasselbe.
  retries: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  // Ein komplettes Spiel mit GAME_TIMING=fast dauert ~30–60 s (Normal-Stack: Specs setzen eigene Fristen).
  timeout: 150_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    { name: "pixel-7", testIgnore: NORMAL_TIMING_SPECS, use: { ...devices["Pixel 7"] } },
    // iPhone-Größe mit Chromium: WebKit ist auf dem Server nicht installiert (ADR-026: nur Chromium-Bibliotheken).
    {
      name: "iphone-15",
      testIgnore: NORMAL_TIMING_SPECS,
      use: { ...devices["iPhone 15"], browserName: "chromium" },
    },
    // Szenario 9: Referenz-Viewports aus docs/09 §4/§13 gegen den Normal-Stack.
    { name: "a11y-360", testMatch: /09-a11y\.spec\.ts$/, use: { ...mobileViewport(360, 740), baseURL: normalBaseURL } },
    { name: "a11y-430", testMatch: /09-a11y\.spec\.ts$/, use: { ...mobileViewport(430, 932), baseURL: normalBaseURL } },
    // Szenario 12: Zeitmessung – erst wenn alle anderen Projekte fertig sind (keine CPU-Konkurrenz), seriell,
    // mit Wiederholungen (Stichprobe über echte Netzwerk- und Render-Zeiten).
    {
      name: "sync",
      testMatch: /12-sync\.spec\.ts$/,
      dependencies: ["pixel-7", "iphone-15", "a11y-360", "a11y-430"],
      retries: 2,
      workers: 1,
      use: { ...devices["Pixel 7"], baseURL: normalBaseURL },
    },
  ],
  webServer: [
    {
      // `exec`: Playwright signalisiert der Prozessgruppe direkt das Stack-Skript (sauberes Aufräumen).
      command: `exec node scripts/dev/stack-test.ts ${stackArgs.join(" ")}`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${webPort}/api/health`,
      timeout: 240_000,
      reuseExistingServer: reuseStack,
      stdout: "pipe",
      stderr: "pipe",
      gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
    },
    {
      // Startet erst, wenn der erste Stack bereit ist (Playwright startet webServer nacheinander) – nutzt
      // dessen Builds.
      command: `exec node e2e/stack/normal-stack.ts ${normalStackArgs.join(" ")}`,
      cwd: repoRoot,
      url: `${normalBaseURL}/api/health`,
      timeout: 120_000,
      reuseExistingServer: reuseStack,
      stdout: "pipe",
      stderr: "pipe",
      gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
    },
  ],
});
