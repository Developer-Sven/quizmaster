import { defineConfig } from "vitest/config";

// Ein Runner für alle Pakete (docs/11). Integrationstests sprechen die Test-DB an
// (lokal: TEST_MONGODB_DB auf dem Dev-Cluster mit Präfix je Lauf, CI: MongoMemoryReplSet).
export default defineConfig({
  test: {
    projects: [
      "packages/shared",
      "packages/game-engine",
      "packages/db",
      "apps/realtime",
      "apps/web",
      "scripts",
      "e2e/smoke",
    ],
    maxWorkers: 2,
    passWithNoTests: true,
  },
});
