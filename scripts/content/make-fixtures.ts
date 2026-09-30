// node scripts/content/make-fixtures.ts [--check] [--out <pfad>]
// Erzeugt die synthetischen Fixtures unter test/fixtures/content (deterministisch, ADR-021).
// --out nur in einen fehlenden/leeren Ordner oder einen bestehenden Fixture-Katalog – nie nach content/.
// --check: nur vergleichen (Exit 1, wenn die Dateien nicht zum Generator passen).
import { fail, parseCli } from "./lib/cli.ts";
import { checkFixtures, FixtureTargetError, writeFixtures } from "./lib/fixtures-io.ts";
import { displayPath, FIXTURES_CONTENT_DIR, resolveCliPath } from "./lib/paths.ts";

const { values } = parseCli(
  { check: { type: "boolean", default: false }, out: { type: "string" } },
  "node scripts/content/make-fixtures.ts [--check] [--out <pfad>]",
);
const dir = values.out === undefined ? FIXTURES_CONTENT_DIR : resolveCliPath(values.out);

if (values.check) {
  const problems = checkFixtures(dir);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    fail(`Fixtures in ${displayPath(dir)} sind nicht aktuell – neu erzeugen: node scripts/content/make-fixtures.ts`);
  }
  console.info(`Fixtures in ${displayPath(dir)} sind aktuell.`);
} else {
  let result: ReturnType<typeof writeFixtures>;
  try {
    result = writeFixtures(dir);
  } catch (error) {
    if (error instanceof FixtureTargetError) fail(error.message);
    throw error;
  }
  console.info(
    `Fixtures geschrieben: ${result.written} Dateien nach ${displayPath(dir)} (${result.removed} entfernt).`,
  );
  if (!result.formatted) {
    console.warn("Biome nicht gefunden – bitte formatieren: pnpm exec biome format --write test/fixtures/content");
  }
}
