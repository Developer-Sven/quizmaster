import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoggerEvent, PluginOptions } from "babel-plugin-react-compiler";
import { describe, expect, it } from "vitest";

/**
 * Sicherheitsnetz für den React Compiler (`reactCompiler: true` in next.config.ts): Verletzt eine
 * Komponente die Rules of React (z. B. `ref.current` oder `setState` im Render), überspringt der
 * Compiler sie mit dem Standard-`panicThreshold` („none“) lautlos – sie verliert die automatische
 * Memoisierung ohne Lint- oder Build-Fehler; Biome kennt diese Regeln nicht (ADR-013) und die CI baut
 * kein `next build`. Hier wird jede Quelldatei mit `panicThreshold: "all_errors"` kompiliert.
 * Babel kommt aus Next selbst (dieselbe Kombination nutzt `next build`), also kein Zusatzpaket;
 * verschwindet der Pfad bei einem Next-Update, schlägt der Test laut fehl.
 */
const require = createRequire(import.meta.url);
const babel = require("next/dist/compiled/babel/core") as {
  transformSync(code: string, options: Record<string, unknown>): unknown;
};
const reactCompiler = (require("babel-plugin-react-compiler") as { default: unknown }).default;

const SRC = fileURLToPath(new URL("../../", import.meta.url));

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

interface CompileResult {
  compiled: number;
  problems: string[];
}

/** Kompiliert eine Datei wie `next build` (Modus „infer“, React 19), bricht aber bei jedem Fehler ab. */
function compile(filename: string, code: string): CompileResult {
  const result: CompileResult = { compiled: 0, problems: [] };
  const options: PluginOptions = {
    panicThreshold: "all_errors",
    target: "19",
    logger: {
      logEvent(_file: string | null, event: LoggerEvent) {
        if (event.kind === "CompileSuccess") result.compiled += 1;
        else if (event.kind === "CompileSkip") result.problems.push(`übersprungen: ${event.reason}`);
        else if (event.kind === "CompileError" || event.kind === "CompileDiagnostic") {
          result.problems.push(`${event.kind}: ${event.detail.reason}`);
        } else if (event.kind === "PipelineError") result.problems.push(`PipelineError: ${event.data}`);
      },
    },
  };
  try {
    babel.transformSync(code, {
      filename,
      babelrc: false,
      configFile: false,
      code: false,
      sourceType: "module",
      parserOpts: { plugins: filename.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
      plugins: [[reactCompiler, options]],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!result.problems.length) result.problems.push(message.split("\n")[0] ?? message);
  }
  return result;
}

describe("React Compiler (Rules of React)", () => {
  // lokal ~1 s für alle Dateien; Puffer für langsame CI-Runner
  it("kompiliert jede Komponente und jeden Hook in apps/web/src ohne Abbruch", { timeout: 30_000 }, () => {
    const sources = walk(SRC).filter((path) => /\.tsx?$/.test(path) && !path.endsWith(".test.ts"));
    let compiled = 0;
    const problems: string[] = [];
    for (const path of sources) {
      const file = relative(SRC, path).split(sep).join("/");
      const result = compile(path, readFileSync(path, "utf8"));
      compiled += result.compiled;
      problems.push(...result.problems.map((problem) => `${file}: ${problem}`));
    }
    expect(problems).toEqual([]);
    // Prüfstand läuft wirklich: Designsystem und Musterseite liefern Dutzende Komponenten/Hooks
    expect(compiled).toBeGreaterThanOrEqual(40);
  });

  it("erkennt einen Regelverstoß (Selbsttest des Prüfstands)", () => {
    const broken = `import { useRef } from "react";
export function Broken({ value }: { value: number }) {
  const ref = useRef(0);
  ref.current = value;
  return <span>{ref.current}</span>;
}`;
    const result = compile("broken.tsx", broken);
    expect(result.compiled).toBe(0);
    expect(result.problems.length).toBeGreaterThan(0);
  });
});
