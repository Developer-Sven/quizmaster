import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "realtime",
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Integrationstests laufen gegen die Test-DB (lokal: Dev-Cluster übers Netz, CI: MongoMemoryReplSet).
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
