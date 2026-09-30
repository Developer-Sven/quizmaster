/**
 * Seed-Ablauf ohne Verbindungsaufbau (für CLI und Tests): Content-Ordner prüfen, vollständig
 * validieren (Schema + Regeln – ungültiger Katalog wird nie geseedet), Fixtures-Schutz, dann
 * `seedCatalog()` aus `@quizmaster/db`. Ausgaben enthalten nur Zählungen.
 */
import { type DbLogger, type QuestionPool, type SeedResult, seedCatalog } from "@quizmaster/db";
import type { CategoriesFile } from "@quizmaster/shared/content";
import type { Db } from "mongodb";
import { formatFinding } from "./findings.ts";
import { formatInt } from "./format.ts";
import type { LoadedCatalog } from "./load.ts";
import { displayPath } from "./paths.ts";
import {
  assertContentDir,
  assertNoFixturesToProd,
  assertTargetDatabase,
  isFixtureSource,
  type SeedEnv,
  SeedGuardError,
} from "./seed-guard.ts";
import { validateContentDir } from "./validate.ts";

export interface SeedRunOptions {
  env: SeedEnv;
  contentDir: string;
  dryRun: boolean;
  allowMassRetire: boolean;
  pool?: QuestionPool;
  prefix?: string;
  now?: Date;
  logger?: DbLogger;
}

export interface SeedRunResult {
  result: SeedResult;
  files: number;
  questions: number;
  categories: number;
  fixtures: boolean;
}

export interface PreparedSeed {
  catalog: LoadedCatalog;
  categoriesFile: CategoriesFile;
  fixtures: boolean;
}

/**
 * Prüft Content-Ordner und Katalog (Schema + Regeln) und – soweit schon bekannt – das Ziel. Wirft
 * `SeedGuardError`, bevor irgendetwas verbunden oder geschrieben wird.
 */
export function prepareSeed(
  options: Pick<SeedRunOptions, "env" | "contentDir" | "prefix">,
  dbName: string | undefined,
): PreparedSeed {
  assertContentDir(options.contentDir);
  const validation = validateContentDir(options.contentDir);
  if (validation.errors > 0) {
    const examples = validation.findings
      .filter((finding) => finding.severity === "error")
      .slice(0, 5)
      .map(formatFinding)
      .join("\n");
    throw new SeedGuardError(
      "CONTENT_INVALID",
      `Abbruch: ${validation.errors} Fehler in ${displayPath(options.contentDir)} (pnpm content:validate):\n${examples}`,
    );
  }
  const { catalog } = validation;
  if (catalog.categoriesFile === null) {
    throw new SeedGuardError("CONTENT_INVALID", "Abbruch: categories.json ungültig");
  }
  const prepared = {
    catalog,
    categoriesFile: catalog.categoriesFile,
    fixtures: isFixtureSource(options.contentDir, catalog.categoriesFile),
  };
  assertSeedTarget(prepared, options.env, dbName, options.prefix);
  return prepared;
}

/** Ziel-Prüfungen: Fixtures nie gegen Produktion, Datenbankname passend zur Umgebung, Präfix nur *_test. */
export function assertSeedTarget(
  prepared: PreparedSeed,
  env: SeedEnv,
  dbName: string | undefined,
  prefix: string | undefined,
): void {
  assertNoFixturesToProd(prepared.fixtures, env, dbName);
  if (dbName !== undefined) assertTargetDatabase(env, dbName, prefix);
}

export async function runSeed(
  db: Db,
  options: SeedRunOptions,
  prepared: PreparedSeed = prepareSeed(options, db.databaseName),
): Promise<SeedRunResult> {
  assertSeedTarget(prepared, options.env, db.databaseName, options.prefix);
  const { catalog, categoriesFile, fixtures } = prepared;
  const result = await seedCatalog(
    db,
    {
      categoriesFile,
      questions: catalog.questions.map((question) => ({
        category: question.category,
        topic: question.topic,
        entry: question.entry,
      })),
    },
    {
      dryRun: options.dryRun,
      allowMassRetire: options.allowMassRetire,
      pool: options.pool ?? "all",
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    },
  );
  return {
    result,
    files: catalog.files.length,
    questions: catalog.questions.length,
    categories: categoriesFile.categories.length,
    fixtures,
  };
}

/** Zeilen für die Konsole – nur Zählungen. */
export function describeSeedRun(run: SeedRunResult): string[] {
  const { plan, changes, written, after, dryRun } = run.result;
  const lines = [
    `Katalog: ${formatInt(run.files)} Dateien, ${formatInt(run.questions)} Fragen, ${run.categories} Kategorien` +
      (run.fixtures ? " (Test-Fixtures)" : ""),
    `Fragen: neu ${formatInt(plan.inserts.length)} · Inhalt geändert ${formatInt(plan.contentUpdates.length)} · ` +
      `Status geändert ${formatInt(plan.statusChanges.length)} · retired (aus Repo entfernt) ${formatInt(plan.removals.length)} · ` +
      `unverändert ${formatInt(plan.unchanged)} (autoRetired erhalten ${formatInt(plan.keptAutoRetired)}) · ` +
      `needs_fix/retired ohne DB-Eintrag ${formatInt(plan.skippedInactive)}`,
    `Kategorien: zu schreiben ${plan.categoryChanges.length} · unverändert ${plan.categoriesUnchanged} · ` +
      `appConfig.catalog: ${plan.catalog.changed ? "ändern" : "unverändert"} (minPlayable ${plan.catalog.config.minPlayable})`,
    `Massen-Retire-Prüfung: ${formatInt(plan.massRetire.retiring)} von ${formatInt(plan.massRetire.playableBefore)} ` +
      `spielbaren Fragen würden retired (${(plan.massRetire.ratio * 100).toFixed(1).replace(".", ",")} %)`,
    `Soll-Zustand: ${formatInt(plan.totals.questions)} Fragen, davon ${formatInt(plan.totals.playable)} spielbar ` +
      `(${formatInt(plan.totals.approved)} approved, ${formatInt(plan.totals.retired)} retired) · ` +
      `${plan.totals.categories} Kategorien, davon ${plan.totals.playableCategories} spielbar`,
    `Änderungen: ${formatInt(changes)}${dryRun ? " (Dry-Run – nichts geschrieben)" : ""}`,
  ];
  if (written && after) {
    const byStatus = Object.entries(after.byStatus)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => `${status} ${formatInt(count)}`)
      .join(", ");
    lines.push(
      `Geschrieben: neu ${formatInt(written.inserted)} · Inhalt ${formatInt(written.contentUpdated)} · ` +
        `Status ${formatInt(written.statusChanged)} · retired ${formatInt(written.retired)} · ` +
        `Kategorien ${written.categoriesWritten} · Katalog ${written.catalogWritten ? "ja" : "nein"} · Konflikte ${written.conflicts}`,
      `Datenbank danach: ${formatInt(after.questions)} Fragen (${byStatus}) · ${after.categories} Kategorien, ` +
        `davon ${after.playableCategories} spielbar`,
    );
  }
  return lines;
}
