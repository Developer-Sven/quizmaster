// Manifest eines Backups aus dem mongodump-Log (Aufruf aus infra/ops/backup.sh):
//
//   node scripts/ops/dump-manifest.ts --log <dump.log> --db <name> --archive <dateiname> --out <manifest.json>
//
// Das Manifest hält fest, wie viele Dokumente je Collection ins Archiv geschrieben wurden; restore-test.sh
// vergleicht damit. Enthält nur Collection-Namen und Zahlen.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { collectionOf, parseDumpLog } from "./lib/mongo-tools.ts";

const { values } = parseArgs({
  options: {
    log: { type: "string" },
    db: { type: "string" },
    archive: { type: "string" },
    out: { type: "string" },
  },
});

try {
  if (!values.log || !values.db || !values.archive || !values.out) {
    throw new Error("Aufruf: dump-manifest.ts --log <datei> --db <name> --archive <name> --out <datei>");
  }
  const counts = parseDumpLog(readFileSync(values.log, "utf8"));
  const collections: Record<string, number> = {};
  for (const [namespace, count] of counts) {
    const name = collectionOf(namespace, values.db);
    if (name !== null) collections[name] = count;
  }
  const names = Object.keys(collections).sort();
  if (names.length === 0) throw new Error(`mongodump-Log enthält keine Collections der Datenbank ${values.db}`);
  const total = names.reduce((sum, name) => sum + (collections[name] ?? 0), 0);
  const manifest = {
    archive: values.archive,
    database: values.db,
    createdAt: new Date().toISOString(),
    collections: Object.fromEntries(names.map((name) => [name, collections[name] ?? 0])),
    totalDocuments: total,
  };
  writeFileSync(values.out, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(`MANIFEST_COLLECTIONS=${names.length}`);
  console.log(`MANIFEST_DOCUMENTS=${total}`);
} catch (error) {
  console.error(`dump-manifest – ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
