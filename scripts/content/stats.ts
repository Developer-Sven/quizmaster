// pnpm content:stats [--gaps] [--write] [--content-dir <pfad>]
// Mengen je Kategorie/Thema/Schwierigkeit/Status. --write schreibt <content>/STATUS.md im bestehenden
// Format, --gaps zeigt die Lücken bis zum Ausbau-Ziel (docs/08 §7).
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, parseCli } from "./lib/cli.ts";
import { loadCatalog } from "./lib/load.ts";
import { DEFAULT_CONTENT_DIR, displayPath, resolveCliPath, STATUS_FILE } from "./lib/paths.ts";
import { computeStats, renderGaps, renderStatusMarkdown, renderSummary } from "./lib/stats.ts";

const { values } = parseCli(
  {
    gaps: { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    "content-dir": { type: "string" },
  },
  "pnpm content:stats [--gaps] [--write] [--content-dir <pfad>]",
);
const dir = values["content-dir"] === undefined ? DEFAULT_CONTENT_DIR : resolveCliPath(values["content-dir"]);
if (!existsSync(dir)) fail(`Content-Ordner fehlt: ${displayPath(dir)} (--content-dir angeben)`);

const catalog = loadCatalog(dir);
if (catalog.categoriesFile === null)
  fail(`${displayPath(dir)}: categories.json fehlt oder ist ungültig – pnpm content:validate`);
const loadErrors = catalog.findings.filter((finding) => finding.severity === "error").length;
if (loadErrors > 0) {
  console.warn(
    `content:stats – ${loadErrors} Lade-/Schemafehler, betroffene Fragen fehlen in den Zahlen (pnpm content:validate)`,
  );
}

const stats = computeStats(catalog.categoriesFile, catalog.questions);
console.info(renderSummary(stats));
if (values.gaps) console.info(`\n${renderGaps(stats)}`);
if (values.write) {
  const target = join(dir, STATUS_FILE);
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, renderStatusMarkdown(stats, new Date()));
  renameSync(temp, target);
  console.info(`content:stats – ${displayPath(target)} geschrieben`);
}
