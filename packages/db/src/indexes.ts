/**
 * `ensureIndexes()` (docs/04 §Indizes, docs/02 §Start-Checks 5): legt idempotent alle Indizes an,
 * setzt den `$jsonSchema`-Validator auf `questions` und sorgt für das `appConfig`-Dokument mit
 * Startwerten (`$setOnInsert` – bestehende Werte bleiben unangetastet).
 *
 * Aufrufer: Realtime beim Start und der Seed (nicht Web). Indizes haben feste Namen – ein gleichnamiger
 * Index mit anderer Definition bricht bewusst mit klarer Meldung ab, statt still gelöscht zu werden.
 */

import { isDeepStrictEqual } from "node:util";
import { APP_CONFIG_ID, defaultAppConfig } from "@quizmaster/shared/documents";
import type { CreateIndexesOptions, Db, IndexDirection } from "mongodb";
import { type CollectionKey, collectionName, getCollections } from "./collections.ts";
import { hasMongoErrorCode, isUnauthorizedError, MONGO_ERROR_CODES } from "./errors.ts";
import { type DbLogger, describeError, silentLogger } from "./logger.ts";
import { QUESTIONS_VALIDATION_OPTIONS, QUESTIONS_VALIDATOR } from "./validators.ts";

export interface IndexDefinition {
  collection: CollectionKey;
  /** Fester Name – macht `ensureIndexes()` idempotent und Fehler eindeutig zuordenbar. */
  name: string;
  key: Record<string, IndexDirection>;
  options?: Omit<CreateIndexesOptions, "name">;
}

const TTL = { expireAfterSeconds: 0 } as const;

/** Alle Indizes aus docs/04 (Tabelle „Indizes“). */
export const INDEX_DEFINITIONS: readonly IndexDefinition[] = [
  { collection: "guests", name: "expiresAt_ttl", key: { expiresAt: 1 }, options: TTL },
  {
    collection: "lobbies",
    name: "code_active_unique",
    key: { code: 1 },
    // Codes nur unter aktiven Lobbys eindeutig – geschlossene Lobbys geben ihren Code frei.
    options: { unique: true, partialFilterExpression: { active: true } },
  },
  { collection: "lobbies", name: "expiresAt_ttl", key: { expiresAt: 1 }, options: TTL },
  { collection: "lobbies", name: "createdByGuestId_active", key: { createdByGuestId: 1, active: 1 } },
  { collection: "lobbies", name: "ownerInstanceId_active", key: { "owner.instanceId": 1, active: 1 } },
  { collection: "games", name: "expiresAt_ttl", key: { expiresAt: 1 }, options: TTL },
  { collection: "games", name: "playersGuestId_endedAt", key: { "players.guestId": 1, endedAt: -1 } },
  { collection: "categories", name: "playable_order", key: { playable: 1, order: 1 } },
  {
    collection: "questions",
    name: "status_category_difficulty",
    key: { status: 1, category: 1, difficulty: 1 },
  },
  { collection: "questions", name: "updatedAt", key: { updatedAt: 1 } },
  { collection: "questionReports", name: "status_createdAt", key: { status: 1, createdAt: -1 } },
  { collection: "questionReports", name: "questionId_createdAt", key: { questionId: 1, createdAt: -1 } },
  { collection: "questionReports", name: "expiresAt_ttl", key: { expiresAt: 1 }, options: TTL },
  { collection: "questionRatings", name: "questionId", key: { questionId: 1 } },
  { collection: "questionRatings", name: "expiresAt_ttl", key: { expiresAt: 1 }, options: TTL },
  { collection: "bans", name: "kind_value_unique", key: { kind: 1, value: 1 }, options: { unique: true } },
  { collection: "bans", name: "expiresAt_ttl", key: { expiresAt: 1 }, options: TTL },
  // rateLimits (Mongo-Store von rate-limiter-flexible, docs/06): genau die Definitionen der Bibliothek
  // (`RateLimiterMongo.createIndexes`) – mit ihren Standardnamen, damit die von Web/Realtime bereits angelegten
  // Indizes ohne Konflikt als vorhanden gelten. TTL räumt abgelaufene Zähler weg, `key` ist je Schlüssel eindeutig.
  { collection: "rateLimits", name: "expire_-1", key: { expire: -1 }, options: TTL },
  { collection: "rateLimits", name: "key_1", key: { key: 1 }, options: { unique: true } },
  {
    collection: "socketioEvents",
    name: "createdAt_ttl",
    key: { createdAt: 1 },
    options: { expireAfterSeconds: 3_600 },
  },
];

export type ValidatorOutcome = "created" | "updated" | "unchanged" | "skipped_unauthorized";

export interface EnsureIndexesResult {
  /** Anzahl definierter Indizes (alle geprüft/angelegt). */
  indexes: number;
  questionsValidator: ValidatorOutcome;
  /** true, wenn das appConfig-Dokument neu angelegt wurde. */
  appConfigCreated: boolean;
}

export interface EnsureIndexesOptions {
  /** Test-Präfix (nur `*_test`-Datenbanken). */
  prefix?: string;
  logger?: DbLogger;
  now?: Date;
}

/** Gruppiert die Definitionen je Collection (ein `createIndexes`-Aufruf pro Collection). */
function definitionsByCollection(): Map<CollectionKey, IndexDefinition[]> {
  const grouped = new Map<CollectionKey, IndexDefinition[]>();
  for (const definition of INDEX_DEFINITIONS) {
    const list = grouped.get(definition.collection) ?? [];
    list.push(definition);
    grouped.set(definition.collection, list);
  }
  return grouped;
}

/**
 * Setzt den Validator auf `questions`: neue Collection → `createCollection` mit Validator; bestehende
 * mit abweichendem Validator → `collMod`. Fehlt das Recht (`Unauthorized`), wird klar gewarnt und
 * weitergemacht – der Validator ist Zusatzschutz, kein Startkriterium.
 */
export async function ensureQuestionsValidator(
  db: Db,
  options: { prefix?: string; logger?: DbLogger } = {},
): Promise<ValidatorOutcome> {
  const logger = options.logger ?? silentLogger;
  const name = collectionName("questions", options.prefix);
  const [existing] = await db.listCollections({ name }).toArray();
  if (existing === undefined) {
    try {
      await db.createCollection(name, { validator: QUESTIONS_VALIDATOR, ...QUESTIONS_VALIDATION_OPTIONS });
      return "created";
    } catch (error) {
      // Parallel angelegt (z. B. Realtime-Start + Seed): dann wie eine bestehende Collection behandeln.
      if (!hasMongoErrorCode(error, MONGO_ERROR_CODES.namespaceExists)) throw error;
    }
  }
  const [current] = await db.listCollections({ name }).toArray();
  const currentOptions = (current as { options?: Record<string, unknown> } | undefined)?.options ?? {};
  const unchanged =
    isDeepStrictEqual(currentOptions.validator, QUESTIONS_VALIDATOR) &&
    currentOptions.validationLevel === QUESTIONS_VALIDATION_OPTIONS.validationLevel &&
    currentOptions.validationAction === QUESTIONS_VALIDATION_OPTIONS.validationAction;
  if (unchanged) return "unchanged";
  try {
    await db.command({ collMod: name, validator: QUESTIONS_VALIDATOR, ...QUESTIONS_VALIDATION_OPTIONS });
    return "updated";
  } catch (error) {
    if (!isUnauthorizedError(error)) throw error;
    logger.warn(
      `ensureIndexes: $jsonSchema-Validator für „${name}“ NICHT gesetzt – dem Datenbank-Benutzer fehlt das Recht ` +
        `collMod (Rolle dbAdmin@${db.databaseName} ergänzen). Weiter ohne Validator (${describeError(error)})`,
    );
    return "skipped_unauthorized";
  }
}

/** Legt das appConfig-Dokument mit Startwerten an, falls es fehlt (bestehende Werte bleiben). */
export async function ensureAppConfig(db: Db, options: { prefix?: string; now?: Date } = {}): Promise<boolean> {
  const { appConfig } = getCollections(db, { prefix: options.prefix });
  const { _id: _ignored, ...defaults } = defaultAppConfig(options.now ?? new Date());
  const result = await appConfig.updateOne({ _id: APP_CONFIG_ID }, { $setOnInsert: defaults }, { upsert: true });
  return result.upsertedCount === 1;
}

/**
 * Idempotent: alle Indizes aus docs/04, Validator auf `questions`, Default-appConfig.
 * Wirft bei Index-Konflikten (gleicher Name, andere Definition) mit klarer Meldung.
 */
export async function ensureIndexes(db: Db, options: EnsureIndexesOptions = {}): Promise<EnsureIndexesResult> {
  const logger = options.logger ?? silentLogger;
  const collections = getCollections(db, { prefix: options.prefix });
  // Validator zuerst: createCollection muss vor createIndexes laufen (sonst legt createIndexes die
  // Collection ohne Validator an).
  const questionsValidator = await ensureQuestionsValidator(db, { prefix: options.prefix, logger });
  for (const [key, definitions] of definitionsByCollection()) {
    try {
      await collections[key].createIndexes(
        definitions.map((definition) => ({ key: definition.key, name: definition.name, ...definition.options })),
      );
    } catch (error) {
      const conflict =
        hasMongoErrorCode(error, MONGO_ERROR_CODES.indexOptionsConflict) ||
        hasMongoErrorCode(error, MONGO_ERROR_CODES.indexKeySpecsConflict);
      if (!conflict) throw error;
      throw new Error(
        `ensureIndexes: Index-Konflikt in „${collectionName(key, options.prefix)}“ – ein Index mit gleichem Namen ` +
          `oder Schlüssel hat eine andere Definition. Bitte bewusst per Migration anpassen (${describeError(error)})`,
      );
    }
  }
  const appConfigCreated = await ensureAppConfig(db, { prefix: options.prefix, now: options.now });
  logger.info(
    `ensureIndexes: ${INDEX_DEFINITIONS.length} Indizes geprüft, Validator questions: ${questionsValidator}` +
      (appConfigCreated ? ", appConfig mit Startwerten angelegt" : ""),
  );
  return { indexes: INDEX_DEFINITIONS.length, questionsValidator, appConfigCreated };
}
