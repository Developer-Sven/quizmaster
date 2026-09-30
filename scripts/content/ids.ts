// pnpm content:ids <kategorie> <n> [--content-dir <pfad>]
// Gibt n neue, im Katalog noch nicht vergebene Fragen-IDs aus (eine pro Zeile).
import { existsSync } from "node:fs";
import { CATEGORY_SLUGS, type CategorySlug } from "@quizmaster/shared/content";
import { fail, parseCli } from "./lib/cli.ts";
import { generateQuestionIds, MAX_IDS_PER_CALL } from "./lib/ids.ts";
import { listQuestionFiles, loadCatalog } from "./lib/load.ts";
import { DEFAULT_CONTENT_DIR, displayPath, resolveCliPath } from "./lib/paths.ts";

const USAGE = "pnpm content:ids <kategorie> <n> [--content-dir <pfad>]";
const { values, positionals } = parseCli({ "content-dir": { type: "string" } }, USAGE);
const [slug, countText] = positionals;
if (slug === undefined || countText === undefined || positionals.length !== 2) fail(`Aufruf: ${USAGE}`, 2);
if (!(CATEGORY_SLUGS as readonly string[]).includes(slug)) {
  fail(`Unbekannte Kategorie „${slug}“ (${CATEGORY_SLUGS.join(", ")})`, 2);
}
const count = Number(countText);
if (!Number.isInteger(count) || count < 1 || count > MAX_IDS_PER_CALL) {
  fail(`<n> muss eine ganze Zahl zwischen 1 und ${MAX_IDS_PER_CALL} sein`, 2);
}

const dir = values["content-dir"] === undefined ? DEFAULT_CONTENT_DIR : resolveCliPath(values["content-dir"]);
const taken = new Set<string>();
if (existsSync(dir) && listQuestionFiles(dir).length > 0) {
  const catalog = loadCatalog(dir);
  for (const question of catalog.questions) taken.add(question.entry.id);
} else {
  console.warn(
    `content:ids – ${displayPath(dir)} fehlt/leer: IDs nur zufällig eindeutig (nicht gegen den Katalog geprüft)`,
  );
}
for (const id of generateQuestionIds(slug as CategorySlug, count, taken)) console.log(id);
