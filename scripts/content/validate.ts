// pnpm content:validate [--file <pfad>]… [--content-dir <pfad>]… [--warnings]
// Schema + Regeln (docs/08 §8) über alle Fragen-Dateien. Ohne Argumente: content/ (falls vorhanden,
// ADR-021) UND test/fixtures/content. Exit 1 bei Fehlern; Warnungen brechen nicht ab.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail, parseCli } from "./lib/cli.ts";
import { type Finding, formatFinding } from "./lib/findings.ts";
import { formatInt } from "./lib/format.ts";
import {
  CATEGORIES_FILE,
  DEFAULT_CONTENT_DIR,
  displayPath,
  FIXTURES_CONTENT_DIR,
  resolveCliPath,
} from "./lib/paths.ts";
import { validateContentDir } from "./lib/validate.ts";

const USAGE = "pnpm content:validate [--file <pfad>]… [--content-dir <pfad>]… [--warnings]";
const { values } = parseCli(
  {
    file: { type: "string", multiple: true },
    "content-dir": { type: "string", multiple: true },
    warnings: { type: "boolean", default: false },
  },
  USAGE,
);

/** Content-Ordner einer Themen-Datei: …/<dir>/questions/<kategorie>/<thema>.json → <dir>. */
function contentDirOf(file: string): string {
  let dir = dirname(file);
  for (let depth = 0; depth < 4; depth++) {
    if (existsSync(join(dir, CATEGORIES_FILE))) return dir;
    dir = dirname(dir);
  }
  return fail(`Kein Content-Ordner (mit ${CATEGORIES_FILE}) über ${displayPath(file)} gefunden`);
}

const targets = new Map<string, string[] | undefined>();
for (const file of values.file ?? []) {
  const path = resolveCliPath(file);
  if (!existsSync(path)) fail(`Datei fehlt: ${displayPath(path)}`);
  const dir = contentDirOf(path);
  targets.set(dir, [...(targets.get(dir) ?? []), path]);
}
for (const dir of values["content-dir"] ?? []) {
  const path = resolveCliPath(dir);
  if (!existsSync(path)) fail(`Content-Ordner fehlt: ${displayPath(path)}`);
  targets.set(path, undefined);
}
if (targets.size === 0) {
  if (existsSync(DEFAULT_CONTENT_DIR)) targets.set(DEFAULT_CONTENT_DIR, undefined);
  else console.info("content/ fehlt (öffentliches Repo, ADR-021) – geprüft werden nur die Fixtures.");
  targets.set(FIXTURES_CONTENT_DIR, undefined);
}

function printWarnings(warnings: readonly Finding[]): void {
  if (values.warnings) {
    for (const finding of warnings) console.warn(formatFinding(finding));
    return;
  }
  const byCode = new Map<string, Finding[]>();
  for (const finding of warnings) byCode.set(finding.code, [...(byCode.get(finding.code) ?? []), finding]);
  for (const [code, list] of byCode) {
    console.warn(`⚠ ${list.length}× [${code}] – Beispiele:`);
    for (const finding of list.slice(0, 3)) console.warn(`    ${formatFinding(finding)}`);
  }
  if (warnings.length > 0) console.warn("  (alle Warnungen: --warnings)");
}

let totalErrors = 0;
for (const [dir, onlyFiles] of targets) {
  const result = validateContentDir(dir, onlyFiles === undefined ? {} : { onlyFiles });
  const errors = result.findings.filter((finding) => finding.severity === "error");
  const warnings = result.findings.filter((finding) => finding.severity === "warning");
  for (const finding of errors) console.error(formatFinding(finding));
  printWarnings(warnings);
  const scope =
    onlyFiles === undefined
      ? `${formatInt(result.catalog.files.length)} Dateien`
      : `${onlyFiles.length} von ${formatInt(result.catalog.files.length)} Dateien`;
  console.info(
    `content:validate – ${displayPath(dir)}: ${scope}, ${formatInt(result.catalog.questions.length)} Fragen – ` +
      `${formatInt(result.errors)} Fehler, ${formatInt(result.warnings)} Warnungen`,
  );
  totalErrors += result.errors;
}
if (totalErrors > 0) process.exit(1);
