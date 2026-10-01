// Service Worker bauen (docs/10, ADR-010): src/sw/sw.ts → esbuild → public/sw.js (gitignored).
// Läuft im prebuild vor `next build`/`next dev`, einzeln: `node apps/web/scripts/build-sw.ts`.
// Version: `SW_VERSION` aus der Umgebung (z. B. Commit), sonst der Build-Zeitpunkt – jede neue Version ergibt
// ein byte-verschiedenes Skript, der Browser installiert es und die App zeigt „Neue Version verfügbar“.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const webRoot = path.resolve(import.meta.dirname, "..");

export interface BuildServiceWorkerOptions {
  /** Kennung dieser Version (Standard: `SW_VERSION` bzw. Build-Zeitpunkt) */
  version?: string;
  /** Zieldatei (Standard: public/sw.js) */
  outfile?: string;
}

export interface BuiltServiceWorker {
  outfile: string;
  version: string;
  bytes: number;
}

/** Erlaubte Zeichen der Versionskennung (landet als String-Literal im Skript). */
const VERSION_PATTERN = /^[\w.:+-]{1,64}$/;

export function resolveSwVersion(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string {
  const fromEnv = env.SW_VERSION?.trim();
  if (fromEnv) {
    if (!VERSION_PATTERN.test(fromEnv)) throw new Error("SW_VERSION: nur Buchstaben, Ziffern und . : + - _ (max. 64)");
    return fromEnv;
  }
  return now.toISOString();
}

export async function buildServiceWorker(options: BuildServiceWorkerOptions = {}): Promise<BuiltServiceWorker> {
  const version = options.version ?? resolveSwVersion();
  const outfile = options.outfile ?? path.join(webRoot, "public", "sw.js");
  const result = await build({
    entryPoints: [path.join(webRoot, "src", "sw", "sw.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "eof",
    charset: "utf8",
    logLevel: "warning",
    define: {
      // serwist entfernt damit seine Entwickler-Logs und -Prüfungen
      "process.env.NODE_ENV": JSON.stringify("production"),
      __SW_VERSION__: JSON.stringify(version),
    },
  });
  const [output] = result.outputFiles;
  if (!output || result.outputFiles.length !== 1) throw new Error("esbuild: genau eine Ausgabedatei erwartet");

  // Atomar ersetzen: Ein laufender Server liefert nie ein halb geschriebenes Skript aus.
  mkdirSync(path.dirname(outfile), { recursive: true });
  const temporary = `${outfile}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, output.contents);
    renameSync(temporary, outfile);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { outfile, version, bytes: output.contents.byteLength };
}

if (import.meta.main) {
  const built = await buildServiceWorker();
  console.info(
    `build-sw – ${path.relative(webRoot, built.outfile)} (${(built.bytes / 1024).toFixed(1)} KB, Version ${built.version})`,
  );
}
