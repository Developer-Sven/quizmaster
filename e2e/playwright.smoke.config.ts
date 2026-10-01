import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import type { SmokeReporterOptions } from "./smoke/reporter.ts";
import {
  ARTIFACTS_SUBDIR,
  chromiumArgs,
  HTML_REPORT_SUBDIR,
  parseSmokeSettings,
  prepareOutputDir,
  type SmokeSettings,
  SmokeSettingsError,
  USAGE,
} from "./smoke/settings.ts";

/**
 * Smoke-Test gegen eine LAUFENDE Instanz (Produktionsabnahme, README „Smoke-Test gegen eine laufende Instanz“):
 * eigene Konfiguration ohne `webServer`, eigenes `testDir` (`smoke/`) – nie Teil von `pnpm test:e2e`
 * (`playwright.config.ts`, `testDir: ./tests`) oder der CI. Aufruf: `pnpm --filter e2e test:smoke`.
 *
 * Env: `SMOKE_BASE_URL` (Pflicht), `SMOKE_RESOLVE_TO=<ip>` (Chromium löst den Host auf diese IP auf, dann – und
 * nur dann – werden Zertifikatsfehler ignoriert: Test über den Origin mit Cloudflare-Origin-Zertifikat),
 * `SMOKE_OUTPUT` (Bericht + Artefakte, Standard `e2e/smoke-results`), `SMOKE_PLAY=0` (ohne Spiel).
 *
 * Ein Worker, keine Wiederholungen: Jede Wiederholung legte in der Zielinstanz weitere Gäste und Lobbys an.
 */
function loadSettings(): SmokeSettings {
  try {
    const settings = parseSmokeSettings(process.env, {
      outputDir: resolve(import.meta.dirname, "smoke-results"),
      // pnpm setzt INIT_CWD auf das Verzeichnis, in dem der Befehl aufgerufen wurde.
      cwd: process.env.INIT_CWD ?? process.cwd(),
    });
    prepareOutputDir(settings.outputDir);
    return settings;
  } catch (error) {
    if (!(error instanceof SmokeSettingsError)) throw error;
    console.error(`Smoke-Test abgebrochen: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
}

const settings = loadSettings();
const reporterOptions: SmokeReporterOptions = {
  outputDir: settings.outputDir,
  baseUrl: settings.baseUrl,
  resolveTo: settings.resolveTo,
  play: settings.play,
};

export default defineConfig({
  testDir: "./smoke",
  testMatch: /\.spec\.ts$/,
  outputDir: resolve(settings.outputDir, ARTIFACTS_SUBDIR),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["./smoke/reporter.ts", reporterOptions],
    ["html", { outputFolder: resolve(settings.outputDir, HTML_REPORT_SUBDIR), open: "never" }],
  ],
  use: {
    baseURL: settings.baseUrl,
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    // Nur für den Test über den Origin (SMOKE_RESOLVE_TO): Cloudflare-Origin-Zertifikat ist nicht öffentlich gültig.
    ignoreHTTPSErrors: settings.resolveTo !== null,
    launchOptions: { args: chromiumArgs(settings) },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  // Chromium (ADR-026); die Geräte (Pixel 7, iPhone 15) wählen die Tests je Kontext.
  projects: [{ name: "smoke", use: { ...devices["Pixel 7"], browserName: "chromium" } }],
});
