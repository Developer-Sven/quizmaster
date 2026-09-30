import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "realtime",
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
