/// <reference lib="webworker" />
/**
 * Service Worker (docs/10, ADR-010): statisches Asset – `scripts/build-sw.ts` bündelt diese Datei mit esbuild
 * nach `public/sw.js` (vor `next build`). Laufzeit-Caching mit serwist statt großer Precache-Liste:
 *
 * - `/_next/static/*` CacheFirst (unveränderlich, gehasht), Schriften/Icons/Sounds/Flaggen CacheFirst,
 * - Navigationen NetworkFirst mit 3 s Frist, ohne Netz und ohne Cache-Treffer die Offline-Seite,
 * - die Regeln-Seite ebenso, aber mit eigenem, beim Install vorgewärmtem Cache: Die Offline-Seite verlinkt sie,
 * - `/api/*`, `/socket.io/*` und alles andere beantwortet der SW nicht (nie gecacht) – Regeln in `routes.ts`.
 *
 * Update-Fluss: Ein neuer SW wartet, bis die Seite `{ type: "SKIP_WAITING" }` schickt (Banner „Neue Version
 * verfügbar“, components/pwa) – serwist registriert dafür den Message-Listener (`skipWaiting: false`).
 *
 * Gecachte HTML-Seiten tragen die CSP-Nonce ihrer ursprünglichen Antwort (Header und Skripte passen
 * zusammen). Die Seiten spiegeln keine Eingaben ungeprüft zurück, eine wiederverwendete Nonce öffnet daher
 * keinen Injektionsweg; Cookies landen nie im Cache (Set-Cookie ist für Service Worker unsichtbar).
 */
import {
  CacheableResponsePlugin,
  CacheFirst,
  ExpirationPlugin,
  NetworkFirst,
  RangeRequestsPlugin,
  type RouteMatchCallbackOptions,
  type RuntimeCaching,
  Serwist,
} from "serwist";
import { OFFLINE_URL, RULES_URL, SW_DEV_PARAM } from "./protocol";
import {
  CACHE_LIMITS,
  CACHE_NAMES,
  classifyRequest,
  extractStaticAssetUrls,
  NAVIGATION_TIMEOUT_SECONDS,
  outdatedCaches,
  type SwRoute,
} from "./routes";

declare const self: ServiceWorkerGlobalScope;

/** Build-Kennung, von esbuild eingesetzt (`scripts/build-sw.ts`) – jede neue Version ergibt ein neues Skript. */
declare const __SW_VERSION__: string;

/** Per Flag in `next dev` registriert (`/sw.js?dev`): dann keine Next-Dateien cachen. */
const dev = new URL(self.location.href).searchParams.has(SW_DEV_PARAM);

/** Nur vollständige 200-Antworten cachen (keine Weiterleitungen, Fehlerseiten oder Teilantworten). */
const cacheableOk = () => new CacheableResponsePlugin({ statuses: [200] });

const nextStatic = new CacheFirst({
  cacheName: CACHE_NAMES.nextStatic,
  plugins: [cacheableOk(), new ExpirationPlugin({ ...CACHE_LIMITS.nextStatic, purgeOnQuotaError: true })],
});

const assets = new CacheFirst({
  cacheName: CACHE_NAMES.assets,
  plugins: [
    cacheableOk(),
    new ExpirationPlugin({ ...CACHE_LIMITS.assets, purgeOnQuotaError: true }),
    // Audio-Elemente fragen per Range an – aus dem Cache dann eine passende 206-Antwort.
    new RangeRequestsPlugin(),
  ],
});

const pages = new NetworkFirst({
  cacheName: CACHE_NAMES.pages,
  networkTimeoutSeconds: NAVIGATION_TIMEOUT_SECONDS,
  plugins: [cacheableOk(), new ExpirationPlugin({ ...CACHE_LIMITS.pages, purgeOnQuotaError: true })],
});

/**
 * Regeln-Seite: online immer frisch aus dem Netz, ohne Netz die Kopie aus dem eigenen Cache (beim Install
 * vorgewärmt, bei jedem Aufruf erneuert); fehlt auch sie, folgt die Offline-Seite. Der Cache hält genau dieses
 * eine HTML-Dokument – `ignoreVary` ist daher unbedenklich und lässt die Kopie aus der Install-Anfrage sicher auf
 * die Navigation des Browsers passen (andere Anfrage-Header).
 */
const rulesPage = new NetworkFirst({
  cacheName: CACHE_NAMES.rules,
  networkTimeoutSeconds: NAVIGATION_TIMEOUT_SECONDS,
  matchOptions: { ignoreVary: true },
  plugins: [cacheableOk()],
});

function routeIs(route: SwRoute) {
  return ({ request, url, sameOrigin }: RouteMatchCallbackOptions) =>
    classifyRequest({ url, method: request.method, mode: request.mode, sameOrigin }, { dev }) === route;
}

/** Nur die cachenden Routen; `never-cache` und `network` haben bewusst keinen Handler (Browser lädt direkt). */
const runtimeCaching: RuntimeCaching[] = [
  { matcher: routeIs("rules"), handler: rulesPage },
  { matcher: routeIs("navigation"), handler: pages },
  { matcher: routeIs("next-static"), handler: nextStatic },
  { matcher: routeIs("static-asset"), handler: assets },
];

const serwist = new Serwist({
  precacheEntries: [{ url: OFFLINE_URL, revision: __SW_VERSION__ }],
  // Name ausdrücklich: serwist berechnet den Precache-Namen vor `cacheId` – so bleibt er eindeutig unserer.
  precacheOptions: { cacheName: CACHE_NAMES.precache, cleanupOutdatedCaches: true },
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching,
  // Navigation ohne Netz und ohne Cache-Treffer → vorab gecachte Offline-Seite.
  fallbacks: { entries: [{ url: OFFLINE_URL, matcher: ({ request }) => request.mode === "navigate" }] },
  disableDevLogs: true,
});

/**
 * Wärmt die Dateien einer Seite vor (CSS, Skripte, Schrift), damit sie ohne Netz vollständig rendert – über die
 * CacheFirst-Strategie, damit das Ablauf-Plugin die Einträge kennt. Einzelne Fehler sind nicht fatal: Die Seite
 * zeigt ihren Text auch ohne Stile; der SW soll deswegen nicht scheitern.
 */
async function warmPageAssets(event: ExtendableEvent, page: string, html: string): Promise<void> {
  const urls = extractStaticAssetUrls(html);
  const results = await Promise.allSettled(
    urls.map((url) => nextStatic.handle({ event, request: new Request(url, { credentials: "same-origin" }) })),
  );
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed > 0) console.warn(`quizmaster-SW: ${failed} von ${urls.length} Dateien von ${page} nicht gecacht`);
}

/** Dateien der (vorab gecachten) Offline-Seite vorwärmen. */
async function warmOfflineAssets(event: ExtendableEvent): Promise<void> {
  if (dev) return;
  const offline = await serwist.matchPrecache(OFFLINE_URL);
  if (!offline) {
    console.warn("quizmaster-SW: Offline-Seite fehlt im Precache");
    return;
  }
  await warmPageAssets(event, OFFLINE_URL, await offline.text());
}

/**
 * Regeln-Seite vorwärmen – der Link „Regeln“ der Offline-Seite soll ohne Netz zu ihr führen: HTML in ihren
 * eigenen Cache (Schlüssel wie die spätere Navigation), dazu ihre Dateien. Bewusst nicht im Precache: Scheitert
 * das hier, scheitert nicht die ganze Installation (und mit ihr die Offline-Seite) – ohne Kopie führt der Link
 * ohne Netz wie jede Navigation zur Offline-Seite, beim nächsten Aufruf mit Netz füllt NetworkFirst den Cache.
 */
async function warmRulesPage(event: ExtendableEvent): Promise<void> {
  try {
    const request = new Request(RULES_URL, { credentials: "same-origin" });
    const response = await fetch(request);
    if (response.status !== 200 || response.redirected) {
      console.warn(`quizmaster-SW: Regeln-Seite nicht vorgewärmt (Status ${response.status})`);
      return;
    }
    const cache = await self.caches.open(CACHE_NAMES.rules);
    await cache.put(request, response.clone());
    if (!dev) await warmPageAssets(event, RULES_URL, await response.text());
  } catch (error) {
    console.warn(`quizmaster-SW: Regeln-Seite nicht vorgewärmt (${error instanceof Error ? error.name : "unbekannt"})`);
  }
}

/** Caches früherer SW-Versionen mit anderem Namen löschen (eigenes Präfix `qm-`, nie fremde Caches). */
async function deleteOutdatedCaches(): Promise<void> {
  const names = await self.caches.keys();
  await Promise.all(outdatedCaches(names, Object.values(CACHE_NAMES)).map((name) => self.caches.delete(name)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    serwist.handleInstall(event).then(() => Promise.all([warmOfflineAssets(event), warmRulesPage(event)])),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([serwist.handleActivate(event), deleteOutdatedCaches()]));
});

self.addEventListener("fetch", serwist.handleFetch);
