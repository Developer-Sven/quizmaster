// Vor `next build` (und `next dev`): statische Assets erzeugen, die nicht im Repo liegen.
// 1. Flaggen: alle 4x3-SVGs aus flag-icons (MIT) + Lizenz nach public/flags (ADR-021).
// 2. Service Worker: src/sw/sw.ts → esbuild → public/sw.js (docs/10, ADR-010; siehe build-sw.ts).
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { buildServiceWorker } from "./build-sw.ts";

const webRoot = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const flagIconsRoot = path.dirname(require.resolve("flag-icons/package.json"));
const source = path.join(flagIconsRoot, "flags", "4x3");
const target = path.join(webRoot, "public", "flags");

if (!existsSync(source)) throw new Error(`flag-icons: ${source} fehlt`);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
copyFileSync(path.join(flagIconsRoot, "LICENSE"), path.join(target, "LICENSE"));
console.info(`prebuild – Flaggen nach ${path.relative(webRoot, target)} kopiert`);

const sw = await buildServiceWorker();
console.info(
  `prebuild – Service Worker ${path.relative(webRoot, sw.outfile)} gebaut (${(sw.bytes / 1024).toFixed(1)} KB, Version ${sw.version})`,
);
