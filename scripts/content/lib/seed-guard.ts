/**
 * Sicherheitsnetz des Seeds (ADR-021, docs/04 §Seed): Abbruch bei fehlendem/leerem Content-Ordner,
 * bei Fixtures gegen Produktion, bei Produktion ohne `--confirm-prod`, bei unpassenden Datenbanknamen
 * und bei Präfixen außerhalb von `*_test` (ADR-029). Der Massen-Retire-Schutz (> 5 %) sitzt im Seed
 * selbst (`seedCatalog`). Alle Prüfungen laufen, BEVOR eine Verbindung aufgebaut wird.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isTestDatabaseName } from "@quizmaster/db";
import type { CategoriesFile } from "@quizmaster/shared/content";
import { isFixtureCatalog } from "./fixtures.ts";
import { listQuestionFiles } from "./load.ts";
import { CATEGORIES_FILE, displayPath, FIXTURES_CONTENT_DIR, isInside } from "./paths.ts";

export const SEED_GUARD_CODES = [
  "PROD_NOT_CONFIRMED",
  "CONTENT_DIR_MISSING",
  "CONTENT_DIR_EMPTY",
  "CONTENT_INVALID",
  "FIXTURES_TO_PROD",
  "DB_NAME",
  "PREFIX_NOT_ALLOWED",
] as const;
export type SeedGuardCode = (typeof SEED_GUARD_CODES)[number];

export class SeedGuardError extends Error {
  readonly code: SeedGuardCode;

  constructor(code: SeedGuardCode, message: string) {
    super(message);
    this.name = "SeedGuardError";
    this.code = code;
  }
}

export type SeedEnv = "dev" | "prod";

/** `--env prod` nur mit `--confirm-prod` (auch für `--dry-run`: schon Lesen zielt auf Produktion). */
export function assertProdConfirmed(env: SeedEnv, confirmProd: boolean): void {
  if (env === "prod" && !confirmProd) {
    throw new SeedGuardError("PROD_NOT_CONFIRMED", "Abbruch: --env prod braucht zusätzlich --confirm-prod");
  }
}

/** Content-Ordner muss existieren und categories.json + mindestens eine Fragen-Datei enthalten. */
export function assertContentDir(dir: string): void {
  if (!existsSync(dir)) {
    throw new SeedGuardError("CONTENT_DIR_MISSING", `Abbruch: Content-Ordner fehlt (${displayPath(dir)})`);
  }
  if (!existsSync(join(dir, CATEGORIES_FILE)) || listQuestionFiles(dir).length === 0) {
    throw new SeedGuardError(
      "CONTENT_DIR_EMPTY",
      `Abbruch: ${displayPath(dir)} ist leer (categories.json oder questions/**/*.json fehlen) – ` +
        "ein leerer Katalog würde alle Fragen retiren",
    );
  }
}

/** true, wenn der Katalog aus den Test-Fixtures stammt (Pfad oder Markierung in categories.json). */
export function isFixtureSource(dir: string, categoriesFile: Pick<CategoriesFile, "note"> | null): boolean {
  return isInside(dir, FIXTURES_CONTENT_DIR) || (categoriesFile !== null && isFixtureCatalog(categoriesFile));
}

/** Ziel ist Produktion: `--env prod` oder ein Datenbankname ohne `_dev`/`_test`. */
export function isProductionTarget(env: SeedEnv, dbName: string | undefined): boolean {
  if (env === "prod") return true;
  return dbName !== undefined && !dbName.endsWith("_dev") && !isTestDatabaseName(dbName);
}

export function assertNoFixturesToProd(fixtures: boolean, env: SeedEnv, dbName: string | undefined): void {
  if (fixtures && isProductionTarget(env, dbName)) {
    throw new SeedGuardError(
      "FIXTURES_TO_PROD",
      "Abbruch: synthetische Test-Fixtures dürfen nie in Produktion geseedet werden",
    );
  }
}

/** Datenbankname passend zur Umgebung; Präfix nur bei *_test (ADR-029). */
export function assertTargetDatabase(env: SeedEnv, dbName: string, prefix: string | undefined): void {
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(dbName)) {
    throw new SeedGuardError("DB_NAME", `Abbruch: ungültiger Datenbankname „${dbName}“`);
  }
  const devLike = dbName.endsWith("_dev") || isTestDatabaseName(dbName);
  if (env === "dev" && !devLike) {
    throw new SeedGuardError(
      "DB_NAME",
      `Abbruch: „${dbName}“ sieht nach Produktion aus – dafür --env prod --confirm-prod verwenden`,
    );
  }
  if (env === "prod" && devLike) {
    throw new SeedGuardError(
      "DB_NAME",
      `Abbruch: --env prod darf keine _dev/_test-Datenbank beschreiben („${dbName}“)`,
    );
  }
  if (prefix !== undefined && prefix !== "" && !isTestDatabaseName(dbName)) {
    throw new SeedGuardError("PREFIX_NOT_ALLOWED", "Abbruch: Collection-Präfixe nur für *_test-Datenbanken (ADR-029)");
  }
}
