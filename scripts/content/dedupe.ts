// pnpm content:dedupe [--category <slug>] [--content-dir <pfad>] [--limit <n>] [--threshold <0..1>]
// Dubletten innerhalb und zwischen Kategorien: exakt, ähnlich (Trigramm ≥ 0,8), gleicher Fakt, umgedreht.
// Nur Bericht – ändert keine Dateien. Exit 0 (auch mit Funden), 1 nur bei Lade-Fehlern.
import { existsSync } from "node:fs";
import { CATEGORY_SLUGS } from "@quizmaster/shared/content";
import { fail, parseCli } from "./lib/cli.ts";
import { DUPLICATE_KIND_LABELS, DUPLICATE_KINDS, type DuplicatePair, findDuplicates } from "./lib/dedupe.ts";
import { formatInt } from "./lib/format.ts";
import type { LoadedQuestion } from "./lib/load.ts";
import { loadCatalog } from "./lib/load.ts";
import { DEFAULT_CONTENT_DIR, displayPath, resolveCliPath } from "./lib/paths.ts";

const USAGE = "pnpm content:dedupe [--category <slug>] [--content-dir <pfad>] [--limit <n>] [--threshold <0..1>]";
const { values } = parseCli(
  {
    category: { type: "string" },
    "content-dir": { type: "string" },
    limit: { type: "string", default: "15" },
    threshold: { type: "string", default: "0.8" },
  },
  USAGE,
);
const limit = Number(values.limit);
const threshold = Number(values.threshold);
if (!Number.isInteger(limit) || limit < 0) fail("--limit muss eine ganze Zahl ≥ 0 sein", 2);
if (!(threshold > 0 && threshold <= 1)) fail("--threshold muss zwischen 0 und 1 liegen", 2);
if (values.category !== undefined && !(CATEGORY_SLUGS as readonly string[]).includes(values.category)) {
  fail(`Unbekannte Kategorie „${values.category}“`, 2);
}
const dir = values["content-dir"] === undefined ? DEFAULT_CONTENT_DIR : resolveCliPath(values["content-dir"]);
if (!existsSync(dir)) fail(`Content-Ordner fehlt: ${displayPath(dir)} (--content-dir angeben)`);

const catalog = loadCatalog(dir);
const loadErrors = catalog.findings.filter((finding) => finding.severity === "error").length;
if (loadErrors > 0) fail(`${loadErrors} Lade-/Schemafehler – erst pnpm content:validate beheben`);

const started = performance.now();
const result = findDuplicates(catalog.questions, {
  similarThreshold: threshold,
  ...(values.category === undefined ? {} : { category: values.category }),
});
const ms = Math.round(performance.now() - started);

const describe = (question: LoadedQuestion) =>
  `${question.entry.id} (${question.category}/${question.topic}) „${question.entry.prompt}“ → ${question.entry.answers[0]}`;
const similarity = (pair: DuplicatePair) => pair.similarity.toFixed(2).replace(".", ",");

console.info(
  `content:dedupe – ${displayPath(dir)}: ${formatInt(result.questions)} Fragen` +
    `${values.category ? `, Kategorie ${values.category}` : ""} (${ms} ms)`,
);
let total = 0;
for (const kind of DUPLICATE_KINDS) {
  const { within, across } = result.counts[kind];
  total += within + across;
  console.info(
    `  ${DUPLICATE_KIND_LABELS[kind].padEnd(14)} ${formatInt(within + across).padStart(5)}` +
      `  (innerhalb ${formatInt(within)} · zwischen Kategorien ${formatInt(across)})`,
  );
}
console.info(`  ${"gesamt".padEnd(14)} ${formatInt(total).padStart(5)}`);
for (const kind of DUPLICATE_KINDS) {
  const pairs = result.pairs.filter((pair) => pair.kind === kind).slice(0, limit);
  if (pairs.length === 0) continue;
  console.info(`\n${DUPLICATE_KIND_LABELS[kind]} (erste ${pairs.length}):`);
  for (const pair of pairs) {
    console.info(`  [${similarity(pair)}] ${describe(pair.a)}\n         ⇄ ${describe(pair.b)}`);
  }
}
