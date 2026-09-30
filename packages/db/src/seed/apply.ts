/**
 * `seedCatalog()` – führt den Seed-Plan aus (docs/04 §Seed & Migrationen, ADR-021):
 * vorher `ensureIndexes()`, Bestand mit `secondaryPreferred` lesen (entlastet den Primary), Plan
 * berechnen, Sicherheitsnetz gegen Massen-Retire (> 5 %), dann in Blöcken schreiben (`bulkWrite`,
 * `ordered: false`). `dryRun` schreibt nichts – auch keine Indizes.
 */
import { APP_CONFIG_ID, type CatalogConfig, catalogConfigSchema } from "@quizmaster/shared/documents";
import type { AnyBulkWriteOperation, Db } from "mongodb";
import { type Collections, getCollections } from "../collections.ts";
import { type EnsureIndexesResult, ensureIndexes } from "../indexes.ts";
import { type DbLogger, silentLogger } from "../logger.ts";
import { chunk } from "../repos/ids.ts";
import type { QuestionPool } from "../repos/questions.ts";
import {
  countPlanChanges,
  type ExistingQuestion,
  type ExistingState,
  planSeed,
  type QuestionStatusChange,
  type SeedInput,
  type SeedPlan,
} from "./plan.ts";

/** Ab diesem Anteil retired gesetzter spielbarer Fragen bricht der Seed ab (ADR-021). */
export const MASS_RETIRE_THRESHOLD = 0.05;
export const SEED_BATCH_SIZE = 1_000;

export interface SeedOptions {
  /** Test-Präfix (nur `*_test`-Datenbanken). */
  prefix?: string;
  dryRun?: boolean;
  /** Mehr als 5 % Retire bewusst erlauben (`--allow-mass-retire`). */
  allowMassRetire?: boolean;
  massRetireThreshold?: number;
  /** Für `playable` der Kategorien (QUESTION_POOL, Standard `all`). */
  pool?: QuestionPool;
  now?: Date;
  logger?: DbLogger;
  batchSize?: number;
}

export class SeedAbortError extends Error {
  readonly code: "MASS_RETIRE";
  readonly plan: SeedPlan;

  constructor(code: "MASS_RETIRE", message: string, plan: SeedPlan) {
    super(message);
    this.name = "SeedAbortError";
    this.code = code;
    this.plan = plan;
  }
}

export interface SeedWriteResult {
  inserted: number;
  contentUpdated: number;
  statusChanged: number;
  retired: number;
  categoriesWritten: number;
  catalogWritten: boolean;
  /** Geplante Updates, deren erwarteter DB-Stand sich parallel geändert hatte (nicht geschrieben). */
  conflicts: number;
}

export interface SeedAfterCounts {
  questions: number;
  byStatus: Record<string, number>;
  categories: number;
  playableCategories: number;
}

export interface SeedResult {
  dryRun: boolean;
  plan: SeedPlan;
  changes: number;
  indexes?: EnsureIndexesResult;
  written?: SeedWriteResult;
  after?: SeedAfterCounts;
}

/** Liest den Bestand (schmale Projektionen, `secondaryPreferred`). */
export async function loadExistingState(collections: Collections): Promise<ExistingState> {
  const readPreference = "secondaryPreferred";
  const questions = await collections.questions
    .find<ExistingQuestion>(
      {},
      { projection: { _id: 1, category: 1, status: 1, contentHash: 1, autoRetired: 1 }, readPreference },
    )
    .toArray();
  const categories = await collections.categories.find({}, { readPreference }).toArray();
  const config = await collections.appConfig.findOne(
    { _id: APP_CONFIG_ID },
    { projection: { catalog: 1 }, readPreference },
  );
  const parsed = config?.catalog === undefined ? null : catalogConfigSchema.safeParse(config.catalog);
  const catalog: CatalogConfig | null = parsed?.success ? parsed.data : null;
  return { questions, categories, catalog };
}

async function applyPlan(collections: Collections, plan: SeedPlan, batchSize: number): Promise<SeedWriteResult> {
  const { now } = plan;
  const result: SeedWriteResult = {
    inserted: 0,
    contentUpdated: 0,
    statusChanged: 0,
    retired: 0,
    categoriesWritten: 0,
    catalogWritten: false,
    conflicts: 0,
  };

  for (const part of chunk(plan.inserts, batchSize)) {
    const written = await collections.questions.bulkWrite(
      part.map((document) => ({ insertOne: { document } })),
      { ordered: false },
    );
    result.inserted += written.insertedCount;
  }

  const updates: AnyBulkWriteOperation<(typeof plan.inserts)[number]>[] = plan.contentUpdates.map((update) => ({
    updateOne: {
      filter: { _id: update.id, contentHash: update.previousHash },
      update: {
        $set: {
          ...update.fields,
          status: update.status,
          autoRetired: null,
          contentHash: update.contentHash,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
    },
  }));
  for (const part of chunk(updates, batchSize)) {
    const written = await collections.questions.bulkWrite(part, { ordered: false });
    result.contentUpdated += written.matchedCount;
    result.conflicts += part.length - written.matchedCount;
  }

  const writeStatus = async (changes: readonly QuestionStatusChange[]): Promise<number> => {
    let matched = 0;
    for (const part of chunk(changes, batchSize)) {
      const written = await collections.questions.bulkWrite(
        part.map((change) => ({
          updateOne: {
            filter: { _id: change.id, status: change.previousStatus },
            update: { $set: { status: change.status, updatedAt: now } },
          },
        })),
        { ordered: false },
      );
      matched += written.matchedCount;
      result.conflicts += part.length - written.matchedCount;
    }
    return matched;
  };
  result.statusChanged = await writeStatus(plan.statusChanges);
  result.retired = await writeStatus(plan.removals);

  if (plan.categoryChanges.length > 0) {
    const written = await collections.categories.bulkWrite(
      plan.categoryChanges.map((change) => ({
        updateOne: {
          filter: { _id: change.slug },
          update: { $set: { ...change.fields, updatedAt: now } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    result.categoriesWritten = written.matchedCount + written.upsertedCount;
  }

  if (plan.catalog.changed) {
    await collections.appConfig.updateOne(
      { _id: APP_CONFIG_ID },
      { $set: { catalog: plan.catalog.config, updatedAt: now } },
    );
    result.catalogWritten = true;
  }
  return result;
}

async function countAfter(collections: Collections): Promise<SeedAfterCounts> {
  const rows = await collections.questions
    .aggregate<{ _id: string; count: number }>([{ $group: { _id: "$status", count: { $sum: 1 } } }])
    .toArray();
  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row._id] = row.count;
  const questions = rows.reduce((sum, row) => sum + row.count, 0);
  const categories = await collections.categories.countDocuments({});
  const playableCategories = await collections.categories.countDocuments({ playable: true });
  return { questions, byStatus, categories, playableCategories };
}

/**
 * Seedet den Katalog idempotent. Wirft `SeedAbortError` (MASS_RETIRE), wenn mehr als 5 % der
 * spielbaren Fragen retired würden und `allowMassRetire` nicht gesetzt ist – auch im Dry-Run.
 */
export async function seedCatalog(db: Db, input: SeedInput, options: SeedOptions = {}): Promise<SeedResult> {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const collections = getCollections(db, { prefix: options.prefix });

  const indexes = dryRun ? undefined : await ensureIndexes(db, { prefix: options.prefix, logger, now });
  const existing = await loadExistingState(collections);
  const plan = planSeed(input, existing, { pool: options.pool ?? "all", now });
  const changes = countPlanChanges(plan);

  const threshold = options.massRetireThreshold ?? MASS_RETIRE_THRESHOLD;
  if (plan.massRetire.ratio > threshold && options.allowMassRetire !== true) {
    const percent = (plan.massRetire.ratio * 100).toFixed(1);
    throw new SeedAbortError(
      "MASS_RETIRE",
      `Abbruch: ${plan.massRetire.retiring} von ${plan.massRetire.playableBefore} spielbaren Fragen (${percent} %) ` +
        `würden retired (Grenze ${(threshold * 100).toFixed(0)} %). Falsches --content-dir? Bewusst: --allow-mass-retire`,
      plan,
    );
  }

  if (dryRun) return { dryRun, plan, changes };
  const written = await applyPlan(collections, plan, options.batchSize ?? SEED_BATCH_SIZE);
  if (written.conflicts > 0) {
    logger.warn(`Seed: ${written.conflicts} Änderungen übersprungen – Datensätze wurden parallel geändert`);
  }
  const after = await countAfter(collections);
  return { dryRun, plan, changes, ...(indexes === undefined ? {} : { indexes }), written, after };
}
