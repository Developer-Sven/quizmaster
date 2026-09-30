import { defineConfig, devices } from "@playwright/test";

// Grundgerüst (docs/11 E2E). Der Test-Stack (Web + Realtime gegen die Test-DB) wird in W2 angebunden.
const webPort = Number(process.env.E2E_WEB_PORT ?? 3200);

export default defineConfig({
  testDir: "./tests",
  outputDir: process.env.E2E_OUTPUT_DIR ?? "test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "mobile-chromium", use: { ...devices["Pixel 7"] } }],
});
