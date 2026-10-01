import { defineConfig } from "tsdown";

// Workspace-Pakete werden eingebündelt, npm-Abhängigkeiten bleiben extern (docs/03).
// Zwei Programme: der Server (dist/index.mjs) und der Watchdog (dist/watchdog.mjs, pm2 `quizmaster-watchdog`,
// docs/12 §Alarme); gemeinsam genutzte Module landen ggf. in einem eigenen Chunk in dist/.
export default defineConfig({
  // Ausgabenamen fest: dist/index.mjs und dist/watchdog.mjs (ecosystem.config.js, Deploy-Prüfung).
  entry: { index: "src/index.ts", watchdog: "src/watchdog-main.ts" },
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
