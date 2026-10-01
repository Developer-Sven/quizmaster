import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E (docs/11 §E2E-Szenarien): echte Browser (Chromium, ADR-026) mit Mobil-Viewports gegen den vollständigen
 * Test-Stack – `scripts/dev/stack-test.ts` (= `pnpm stack:test`) baut Realtime und Web, seedet die Test-DB
 * (Präfix je Lauf, ADR-029) und startet beide mit `GAME_TIMING=fast`, Dev-Bots und gelockerten Limits. Beim
 * Ende bekommt der Stack SIGTERM und räumt die Test-Collections selbst ab.
 *
 * Env: `E2E_WEB_PORT` / `E2E_REALTIME_PORT` (Standard 3200/4200), `E2E_WORKERS` (1–2, Standard 2),
 * `E2E_OUTPUT_DIR`, `E2E_REUSE_STACK=1` (laufenden `pnpm stack:test` mit denselben Ports nutzen),
 * `E2E_NO_BUILD=1` (vorhandene Builds nutzen).
 */
const repoRoot = resolve(import.meta.dirname, "..");
const webPort = Number(process.env.E2E_WEB_PORT ?? 3200);
const realtimePort = Number(process.env.E2E_REALTIME_PORT ?? 4200);
const workers = Math.min(2, Math.max(1, Number(process.env.E2E_WORKERS ?? 2)));
const outputDir = resolve(import.meta.dirname, process.env.E2E_OUTPUT_DIR ?? "test-results");
const stackArgs = [
  `--web-port ${webPort}`,
  `--realtime-port ${realtimePort}`,
  // Logs von Web/Realtime/Builds neben den Test-Artefakten (CI lädt sie bei Fehlern hoch).
  `--log-dir "${resolve(outputDir, "stack-logs")}"`,
  ...(process.env.E2E_NO_BUILD === "1" ? ["--no-build"] : []),
];

export default defineConfig({
  testDir: "./tests",
  outputDir,
  fullyParallel: false,
  workers,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  // Ein komplettes Spiel mit GAME_TIMING=fast dauert ~30–60 s.
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
    { name: "pixel-7", use: { ...devices["Pixel 7"] } },
    // iPhone-Größe mit Chromium: WebKit ist auf dem Server nicht installiert (ADR-026: nur Chromium-Bibliotheken).
    { name: "iphone-15", use: { ...devices["iPhone 15"], browserName: "chromium" } },
  ],
  webServer: {
    // `exec`: Playwright signalisiert der Prozessgruppe direkt das Stack-Skript (sauberes Aufräumen).
    command: `exec node scripts/dev/stack-test.ts ${stackArgs.join(" ")}`,
    cwd: repoRoot,
    url: `http://127.0.0.1:${webPort}/api/health`,
    timeout: 240_000,
    reuseExistingServer: process.env.E2E_REUSE_STACK === "1",
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
  },
});
