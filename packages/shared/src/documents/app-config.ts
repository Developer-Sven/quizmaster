/**
 * appConfig – genau ein Dokument (`_id: "global"`) mit Kill-Switches, Wartungsmodus und Limits; wird per
 * Change Stream live übernommen (docs/04, docs/06). Ergänzt um `catalog` und `blockedTerms` (ADR-021).
 * Neue Felder haben Defaults, damit ältere Dokumente weiter gelesen werden können (additive Migration).
 */
import { z } from "zod";
import { DEFAULT_DIFFICULTY_MIX, DEFAULT_MIN_PLAYABLE, difficultyMixSchema } from "../content/categories.ts";
import { QUOTAS } from "../limits.ts";

/** Einzelner Blocklisten-Begriff (Live-Ergänzung der Namens-Moderation, docs/06 Runbook). */
export const blockedTermSchema = z.string().trim().min(2).max(64);
export const BLOCKED_TERMS_MAX = 5_000;

/** Katalog-Einstellungen aus `content/categories.json` (beim Seed übernommen, ADR-021). */
export const catalogConfigSchema = z.object({
  /** Kategorie spielbar ab so vielen spielbaren Fragen. */
  minPlayable: z.int().min(1),
  /** Gewichtung der Schwierigkeiten bei der Fragenziehung. */
  difficultyMix: difficultyMixSchema,
});
export type CatalogConfig = z.output<typeof catalogConfigSchema>;

export const DEFAULT_CATALOG_CONFIG: Readonly<CatalogConfig> = Object.freeze({
  minPlayable: DEFAULT_MIN_PLAYABLE,
  difficultyMix: DEFAULT_DIFFICULTY_MIX,
});

export const APP_CONFIG_ID = "global";

export const appConfigDocSchema = z.object({
  _id: z.literal(APP_CONFIG_ID),
  maintenance: z.object({
    enabled: z.boolean(),
    /** Banner-Text; `null` → Standardtext „Wartung – gleich geht es weiter.“ */
    message: z.string().max(200).nullable(),
  }),
  lobbyCreationEnabled: z.boolean(),
  /** Notfall-Schalter bei Bot-Wellen: lobby:create/join nur mit frischem Turnstile-Ticket. */
  turnstileOnJoin: z.boolean(),
  /** Schutz vor Speicher-Erschöpfung. */
  maxActiveLobbies: z.int().min(0).max(1_000_000),
  /** Ältere Clients müssen neu laden (`UPDATE_REQUIRED`). */
  minClientProtocol: z.int().min(1),
  catalog: catalogConfigSchema.default(() => ({
    minPlayable: DEFAULT_MIN_PLAYABLE,
    difficultyMix: { ...DEFAULT_DIFFICULTY_MIX },
  })),
  /** Live-Ergänzungen der Namens-Blockliste (`isNameAcceptable(name, blockedTerms)`). */
  blockedTerms: z
    .array(blockedTermSchema)
    .max(BLOCKED_TERMS_MAX)
    .default(() => []),
  updatedAt: z.date(),
});
export type AppConfigDoc = z.output<typeof appConfigDocSchema>;

/** Startwerte für das appConfig-Dokument (Seed/ensure beim ersten Start). */
export function defaultAppConfig(now: Date): AppConfigDoc {
  return {
    _id: APP_CONFIG_ID,
    maintenance: { enabled: false, message: null },
    lobbyCreationEnabled: true,
    turnstileOnJoin: false,
    maxActiveLobbies: QUOTAS.maxActiveLobbies.defaultMax,
    minClientProtocol: 1,
    catalog: { minPlayable: DEFAULT_MIN_PLAYABLE, difficultyMix: { ...DEFAULT_DIFFICULTY_MIX } },
    blockedTerms: [],
    updatedAt: now,
  };
}
