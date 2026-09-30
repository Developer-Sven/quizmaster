import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "scripts",
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
