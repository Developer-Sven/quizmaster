/**
 * zod-Fassade für die client-erreichbaren Verträge des Haupt-Exports (`@quizmaster/shared`): nur benannte
 * Re-Exporte der tatsächlich genutzten Bausteine. Nutzung: `import * as z from "./zod.ts"` – Aufrufe wie
 * `z.strictObject(…)` und Typen wie `z.output<…>` bleiben unverändert.
 *
 * Warum: `import { z } from "zod"` bindet den Namespace `z` samt `z.locales` (~40 Sprachen). Turbopack kann ihn
 * nicht zerlegen – im Lobby-Chunk landeten alle Locales (63× `localeError`, ~90 KB gzip). Benannte Re-Exporte
 * lassen sich dagegen sauber zerlegen (Messung: zod-Anteil 89,7 → 30,0 KB gzip, 3× `localeError`).
 *
 * Fehlermeldungen: Englisch. zod registriert die englische Locale beim ersten Schema selbst (`en` als Standard,
 * wenn keine gesetzt ist); andere Locales gelangen nicht ins Bundle. Die Meldungen sind nur für Logs gedacht –
 * Clients zeigen Texte aus `i18n/de.ts` je Fehlercode.
 *
 * Server-Code (documents/, env/, content/, Apps) darf weiter direkt `zod` importieren. Neue Bausteine hier
 * benannt ergänzen – nie `export * from "zod"` und nie den Namespace `z` re-exportieren.
 */

export type { infer, input, output, ZodError, ZodSafeParseResult, ZodType } from "zod";
export {
  array,
  boolean,
  discriminatedUnion,
  enum,
  int,
  literal,
  null,
  number,
  object,
  record,
  strictObject,
  string,
  tuple,
  uuid,
} from "zod";
