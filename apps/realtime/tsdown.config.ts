import { defineConfig } from "tsdown";

// Workspace-Pakete werden eingebündelt, npm-Abhängigkeiten bleiben extern (docs/03).
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: true,
  fixedExtension: true,
  deps: { alwaysBundle: [/^@quizmaster\//] },
});
