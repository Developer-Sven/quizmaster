import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "game-engine",
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
