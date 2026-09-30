/**
 * appConfig (docs/04, docs/06 §Kill-Switches): genau ein Dokument `_id: "global"`. Lesen immer über
 * zod (fehlende neue Felder bekommen ihre Defaults – additive Migration), Schreiben nur mit expliziten
 * `$set`-Feldern aus einem validierten Patch.
 */
import {
  APP_CONFIG_ID,
  type AppConfigDoc,
  appConfigDocSchema,
  BLOCKED_TERMS_MAX,
  blockedTermSchema,
  type CatalogConfig,
  catalogConfigSchema,
  defaultAppConfig,
} from "@quizmaster/shared/documents";
import type { Collection, MatchKeysAndValues } from "mongodb";
import { z } from "zod";

/** Änderbare Felder (Admin-CLI, Tests). Mindestens ein Feld. */
export const appConfigPatchSchema = z
  .strictObject({
    maintenance: z.strictObject({ enabled: z.boolean(), message: z.string().max(200).nullable() }).optional(),
    lobbyCreationEnabled: z.boolean().optional(),
    turnstileOnJoin: z.boolean().optional(),
    maxActiveLobbies: z.int().min(0).max(1_000_000).optional(),
    minClientProtocol: z.int().min(1).optional(),
    blockedTerms: z.array(blockedTermSchema).max(BLOCKED_TERMS_MAX).optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "mindestens ein Feld angeben",
  });
export type AppConfigPatch = z.input<typeof appConfigPatchSchema>;

export interface AppConfigRepo {
  /** Aktuelle Konfiguration; fehlt das Dokument, gelten die Startwerte (ensureIndexes legt es an). */
  get(): Promise<AppConfigDoc>;
  update(patch: AppConfigPatch, now: Date): Promise<AppConfigDoc>;
  /** Katalog-Einstellungen aus categories.json (Seed, ADR-021). */
  setCatalog(catalog: CatalogConfig, now: Date): Promise<void>;
}

export function createAppConfigRepo(appConfig: Collection<AppConfigDoc>): AppConfigRepo {
  const get = async (): Promise<AppConfigDoc> => {
    const doc = await appConfig.findOne({ _id: APP_CONFIG_ID });
    if (doc === null) return defaultAppConfig(new Date(0));
    return appConfigDocSchema.parse(doc);
  };

  return {
    get,

    async update(patch, now) {
      const parsed = appConfigPatchSchema.parse(patch);
      const set: Partial<Omit<AppConfigDoc, "_id">> = { updatedAt: now };
      if (parsed.maintenance !== undefined) set.maintenance = parsed.maintenance;
      if (parsed.lobbyCreationEnabled !== undefined) set.lobbyCreationEnabled = parsed.lobbyCreationEnabled;
      if (parsed.turnstileOnJoin !== undefined) set.turnstileOnJoin = parsed.turnstileOnJoin;
      if (parsed.maxActiveLobbies !== undefined) set.maxActiveLobbies = parsed.maxActiveLobbies;
      if (parsed.minClientProtocol !== undefined) set.minClientProtocol = parsed.minClientProtocol;
      if (parsed.blockedTerms !== undefined) set.blockedTerms = parsed.blockedTerms;
      const { _id: _unused, ...defaults } = defaultAppConfig(now);
      const insertDefaults = Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in set)));
      await appConfig.updateOne(
        { _id: APP_CONFIG_ID },
        {
          $set: set as MatchKeysAndValues<AppConfigDoc>,
          $setOnInsert: insertDefaults as MatchKeysAndValues<AppConfigDoc>,
        },
        { upsert: true },
      );
      return get();
    },

    async setCatalog(catalog, now) {
      const parsed = catalogConfigSchema.parse(catalog);
      await appConfig.updateOne({ _id: APP_CONFIG_ID }, { $set: { catalog: parsed, updatedAt: now } });
    },
  };
}
