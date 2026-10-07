"use client";

import { de } from "../../i18n/de";

/**
 * Lädt das Wörterbuch (`i18n/de.ts`) mit dem Chunk des Root-Layouts (ADR-037, docs/07 Initial-JS). Die Fehlergrenze
 * `app/error.tsx` und die Seite sind Geschwister-Einträge des Layouts: Ein Modul, das beide nutzen, legt Turbopack in
 * BEIDE Chunks – das Wörterbuch (≈ 6 KB gzip) lud so auf jeder Seite doppelt. Was ein Client-Modul des Layouts lädt,
 * teilen alle Einträge darunter; so steht es genau einmal im initialen JS, und die Fehlerseite hat ihre Texte auch
 * dann, wenn keine Chunks mehr nachladen. Rendert nichts.
 */
export function SharedDictionary(): null {
  // Die Referenz hält das Modul im Layout-Chunk (ungenutzte Importe entfernt der Build); `pnpm perf:budgets` prüft es.
  void de.app;
  return null;
}
