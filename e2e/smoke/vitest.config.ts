import { defineProject } from "vitest/config";

/**
 * Unit-Tests der reinen Teile des Smoke-Tests (Einstellungen, Header-Auswertung, Bericht). Der Smoke-Test selbst
 * (`*.spec.ts`) läuft nur über Playwright (`pnpm --filter e2e test:smoke`).
 */
export default defineProject({
  test: {
    name: "e2e-smoke",
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
