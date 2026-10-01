/**
 * Gemeinsame Konstanten von Service Worker (`src/sw/sw.ts`) und Seite (`components/pwa`) – docs/10, ADR-010.
 * Keine Worker- oder DOM-Typen: das Modul läuft in beiden Welten und in den Tests.
 */

/** Statisch ausgeliefertes SW-Skript (`scripts/build-sw.ts` → `public/sw.js`, Header in next.config.ts). */
export const SW_URL = "/sw.js";

/** Der SW steuert die ganze App. */
export const SW_SCOPE = "/";

/** Offline-Seite: beim Install vorab gecacht, Rückfall für Navigationen ohne Netz (docs/10). */
export const OFFLINE_URL = "/offline";

/**
 * Regeln-Seite (docs/09 §6): Die Offline-Seite verlinkt sie – der SW wärmt sie deshalb beim Install in einem
 * eigenen Cache vor und frischt sie bei jedem Aufruf auf (NetworkFirst), damit der Link ohne Netz nicht ins
 * Leere führt. Auch Ziel des Links „Regeln“ (components/app/app-footer.tsx).
 */
export const RULES_URL = "/regeln";

/** Nachrichtentyp, mit dem die Seite den wartenden SW aktiviert (serwist wertet genau diesen `type` aus). */
export const SKIP_WAITING = "SKIP_WAITING";

/**
 * Query-Parameter am SW-Skript, wenn er per Flag in `next dev` läuft: Dann cacht er `/_next/static/*` nicht –
 * dort sind die Dateien nicht unveränderlich wie im Produktions-Build.
 */
export const SW_DEV_PARAM = "dev";
