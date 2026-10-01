/**
 * Routing-Regeln des Service Workers als reine Funktionen (docs/10 „Strategien“, docs/07 §Frontend) – der SW
 * (`sw.ts`) hängt die serwist-Strategien daran, die Tests prüfen die Zuordnung ohne Browser.
 *
 * | Anfrage                                   | Route          | Strategie                                  |
 * |-------------------------------------------|----------------|--------------------------------------------|
 * | `/api/*`, `/socket.io/*`                  | `never-cache`  | nie cachen – der SW antwortet nicht        |
 * | Navigation zu genau `/regeln`             | `rules`        | NetworkFirst 3 s, eigener Cache (beim      |
 * |                                           |                | Install vorgewärmt), Rückfall `/offline`   |
 * | Navigationen (HTML)                       | `navigation`   | NetworkFirst 3 s, Rückfall `/offline`      |
 * | `/_next/static/*`                         | `next-static`  | CacheFirst, 300 Einträge, 30 Tage          |
 * | Schriften, Icons, Sounds, Flaggen-SVGs    | `static-asset` | CacheFirst, 200 Einträge, 60 Tage          |
 * | alles andere (auch fremde Origins, POST)  | `network`      | NetworkOnly – der SW antwortet nicht       |
 *
 * „Der SW antwortet nicht“ heißt: kein `respondWith`, der Browser lädt direkt aus dem Netz und nichts landet
 * in einem Cache – NetworkOnly ohne Umweg über den Worker (wichtig für Socket.IO-Long-Polling).
 *
 * Die Regeln-Seite hat einen eigenen Cache, weil die Offline-Seite sie verlinkt: Im Seiten-Cache (20 Einträge,
 * 7 Tage) würden Lobby-Aufrufe sie verdrängen – der Link „Regeln“ führte ohne Netz dann wieder zur Offline-Seite.
 */
import { RULES_URL } from "./protocol";

export type SwRoute = "never-cache" | "rules" | "navigation" | "next-static" | "static-asset" | "network";

/** Was die Regeln von einer Anfrage brauchen (entspricht den Feldern von Request/serwist-Matcher). */
export interface RequestFacts {
  url: URL;
  method: string;
  /** `Request.mode`, z. B. `navigate` für Seitenaufrufe */
  mode: string;
  /** gleiche Origin wie der Service Worker */
  sameOrigin: boolean;
}

export interface RouteOptions {
  /** SW per Flag in `next dev`: `/_next/static/*` ist dort nicht unveränderlich → nicht cachen */
  dev?: boolean;
}

/** Pfade, die nie gecacht und nie vom SW beantwortet werden (Sessions, Tickets, Realtime). */
const NEVER_CACHE_PATHS = ["/api", "/socket.io"] as const;

/** Statische Dateien außerhalb von `/_next/static` (public/): App-Icons, Sounds, Flaggen. */
const ASSET_PREFIXES = ["/icons/", "/sounds/", "/flags/"] as const;

/** Schriften (next/font liegt zwar unter /_next/static/media, eigene Dateien wären es nicht). */
const FONT_EXTENSION = /\.(?:woff2?|ttf|otf)$/i;

const DAY_SECONDS = 24 * 60 * 60;

/** Cache-Namen; die Versionsendung erlaubt spätere Migrationen (alte Namen räumt `outdatedCaches` ab). */
export const CACHE_NAMES = {
  /** serwist-Precache (Offline-Seite), Name ausdrücklich gesetzt */
  precache: "qm-precache-v1",
  nextStatic: "qm-next-static-v1",
  assets: "qm-assets-v1",
  pages: "qm-pages-v1",
  /** genau ein Eintrag: die Regeln-Seite (ohne Ablauf – wird bei jedem Aufruf und jedem Install erneuert) */
  rules: "qm-rules-v1",
} as const;

/** Präfix aller eigenen Caches – nur sie räumt der SW beim Aktivieren ab. */
export const CACHE_ID = "qm";

/** Grenzen laut docs/10; Seiten (nicht in docs/10 beziffert) klein halten: Lobby-URLs sind kurzlebig. */
export const CACHE_LIMITS = {
  nextStatic: { maxEntries: 300, maxAgeSeconds: 30 * DAY_SECONDS },
  assets: { maxEntries: 200, maxAgeSeconds: 60 * DAY_SECONDS },
  pages: { maxEntries: 20, maxAgeSeconds: 7 * DAY_SECONDS },
} as const;

/** Netzwerk-Frist für Navigationen, danach Cache (docs/10). */
export const NAVIGATION_TIMEOUT_SECONDS = 3;

/** Höchstens so viele Dateien je vorgewärmter Seite (Offline, Regeln) werden beim Install gecacht. */
export const OFFLINE_ASSET_LIMIT = 64;

function matchesPath(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** `/api/*` und `/socket.io/*` (auch ohne Schrägstrich am Ende). */
export function isNeverCached(pathname: string): boolean {
  return NEVER_CACHE_PATHS.some((base) => matchesPath(pathname, base));
}

/** Gehashte, unveränderliche Next-Dateien (JS, CSS, Schriften aus next/font). */
export function isNextStatic(pathname: string): boolean {
  return pathname.startsWith("/_next/static/");
}

/** Schriften, Icons, Sounds und Flaggen-SVGs. */
export function isStaticAsset(pathname: string): boolean {
  return ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix)) || FONT_EXTENSION.test(pathname);
}

/**
 * Die Regeln-Seite genau unter ihrer Adresse – ohne Query (z. B. `?utm_…`): So hält ihr Cache immer nur einen
 * Eintrag; andere Schreibweisen laufen wie jede Navigation über den Seiten-Cache.
 */
export function isRulesPage(url: URL): boolean {
  return url.pathname === RULES_URL && url.search === "";
}

/** Ordnet eine Anfrage genau einer Route zu (Reihenfolge = Vorrang, siehe Tabelle oben). */
export function classifyRequest(request: RequestFacts, options: RouteOptions = {}): SwRoute {
  if (request.method !== "GET" || !request.sameOrigin) return "network";
  const { pathname } = request.url;
  if (isNeverCached(pathname)) return "never-cache";
  if (request.mode === "navigate") return isRulesPage(request.url) ? "rules" : "navigation";
  if (isNextStatic(pathname)) return options.dev ? "network" : "next-static";
  if (isStaticAsset(pathname)) return "static-asset";
  return "network";
}

/** Routen, für die der SW eine Cache-Strategie anwendet; alle anderen beantwortet er nicht. */
export function isCachedRoute(route: SwRoute): route is "rules" | "navigation" | "next-static" | "static-asset" {
  return route === "rules" || route === "navigation" || route === "next-static" || route === "static-asset";
}

/**
 * `/_next/static/…`-Verweise aus dem HTML einer vorgewärmten Seite (Offline, Regeln: Skripte, CSS, vorgeladene
 * Schriften, Chunks im RSC-Payload) – sie werden beim Install vorab gecacht, damit die Seite ohne Netz
 * vollständig rendert. Nur eigene, relative Pfade; Duplikate und Escape-Reste fallen weg.
 */
export function extractStaticAssetUrls(html: string, limit = OFFLINE_ASSET_LIMIT): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/\/_next\/static\/[^"'\s<>()\\]+/g)) {
    const path = match[0].replace(/&amp;/g, "&");
    if (path.includes("..")) continue;
    found.add(path);
    if (found.size >= limit) break;
  }
  return [...found];
}

/** Eigene Caches (Präfix `qm-`), die nicht mehr zur aktuellen Version gehören → beim Aktivieren löschen. */
export function outdatedCaches(names: readonly string[], keep: readonly string[]): string[] {
  const current = new Set(keep);
  return names.filter((name) => name.startsWith(`${CACHE_ID}-`) && !current.has(name));
}
