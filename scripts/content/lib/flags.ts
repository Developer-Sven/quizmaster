/**
 * Gültige Flaggen-Codes = vorhandene 4x3-SVGs aus `flag-icons` (MIT, devDependency von scripts). Der
 * Web-Build kopiert genau diese Dateien nach `public/flags/` (ADR-021) – ein Code ohne Datei wäre im
 * Spiel ein kaputtes Bild.
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let cached: ReadonlySet<string> | undefined;

/** Verzeichnis `flag-icons/flags/4x3`. */
export function flagIconsDir(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("flag-icons/package.json")), "flags", "4x3");
}

export function loadFlagCodes(): ReadonlySet<string> {
  cached ??= new Set(
    readdirSync(flagIconsDir())
      .filter((file) => file.endsWith(".svg"))
      .map((file) => file.slice(0, -".svg".length)),
  );
  return cached;
}
