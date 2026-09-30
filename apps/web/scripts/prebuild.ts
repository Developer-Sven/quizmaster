// Vor `next build`: statische Assets erzeugen, die nicht im Repo liegen.
// Flaggen: alle 4x3-SVGs aus flag-icons (MIT) + Lizenz nach public/flags (ADR-021).
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

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
