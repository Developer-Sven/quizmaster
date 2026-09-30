// pnpm content:digest <kategorie> [thema] [--content-dir <pfad>]
// Kompakte Liste „Frage → richtige Antwort“ (Arbeitsgrundlage für neue Fragen, docs/08 §8).
import { existsSync } from "node:fs";
import { fail, parseCli } from "./lib/cli.ts";
import { renderDigest } from "./lib/digest.ts";
import { loadCatalog } from "./lib/load.ts";
import { DEFAULT_CONTENT_DIR, displayPath, resolveCliPath } from "./lib/paths.ts";

const USAGE = "pnpm content:digest <kategorie> [thema] [--content-dir <pfad>]";
const { values, positionals } = parseCli({ "content-dir": { type: "string" } }, USAGE);
const [slug, topic] = positionals;
if (slug === undefined || positionals.length > 2) fail(`Aufruf: ${USAGE}`, 2);
const dir = values["content-dir"] === undefined ? DEFAULT_CONTENT_DIR : resolveCliPath(values["content-dir"]);
if (!existsSync(dir)) fail(`Content-Ordner fehlt: ${displayPath(dir)} (--content-dir angeben)`);

const catalog = loadCatalog(dir);
if (catalog.categoriesFile === null) fail(`${displayPath(dir)}: categories.json fehlt oder ist ungültig`);
try {
  process.stdout.write(renderDigest(catalog.categoriesFile, catalog.questions, slug, topic));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 2);
}
