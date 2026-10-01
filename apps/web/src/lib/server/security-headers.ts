/**
 * Content-Security-Policy mit Nonce und laufzeitabhängige Sicherheitsheader (docs/06 §HTTP-Sicherheitsheader
 * & CSP, ADR-008). Reine Funktionen – `proxy.ts` setzt sie pro Request, Tests prüfen sie direkt.
 * Env-unabhängige Header stehen in `next.config.ts` (`headers()`), weil sie beim Build feststehen.
 */
import type { WebEnv } from "../../env";

/** Turnstile: Skript/Iframe/Siteverify-Domain (docs/06). */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export const HSTS_VALUE = "max-age=63072000; includeSubDomains";

/** Request-Header, über den Server-Komponenten die Nonce lesen (`getRequestNonce()`). */
export const NONCE_HEADER = "x-nonce";

type CspEnv = Pick<WebEnv, "appOrigins" | "realtimeUrl" | "httpsOrigin" | "nodeEnv">;

/** 128 Bit Zufall, Base64 – pro Request neu (Web Crypto: läuft in jeder Runtime). */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Realtime-Quellen für `connect-src`: die Origin aus `REALTIME_URL` bzw. (leer = gleiche Origin) jede
 * `APP_ORIGIN` – jeweils als ws(s)- UND http(s)-Origin, weil ältere Safari-Versionen `wss:` nicht zuverlässig
 * über `'self'` zulassen (docs/06).
 */
export function realtimeConnectSources(env: Pick<WebEnv, "appOrigins" | "realtimeUrl">): string[] {
  const origins = env.realtimeUrl === "" ? env.appOrigins : [env.realtimeUrl];
  const sources = new Set<string>();
  for (const origin of origins) {
    const url = new URL(origin);
    sources.add(`${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`);
    sources.add(url.origin);
  }
  return [...sources];
}

/** CSP exakt nach docs/06; `'unsafe-eval'` nur in `next dev`, `upgrade-insecure-requests` nur bei https. */
export function buildContentSecurityPolicy(nonce: string, env: CspEnv): string {
  const directives: string[][] = [
    ["default-src", "'self'"],
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(env.nodeEnv === "development" ? ["'unsafe-eval'"] : []),
    ],
    // KEINE Nonce in style-src – sonst ignorieren Browser 'unsafe-inline' (React-Style-Attribute, Motion).
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:"],
    ["font-src", "'self'"],
    ["connect-src", "'self'", ...realtimeConnectSources(env), TURNSTILE_ORIGIN],
    ["frame-src", TURNSTILE_ORIGIN],
    ["worker-src", "'self'"],
    ["manifest-src", "'self'"],
    ["media-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  if (env.httpsOrigin) directives.push(["upgrade-insecure-requests"]);
  return directives.map((directive) => directive.join(" ")).join("; ");
}

/**
 * HTML-Dokumente: nie cachen (Nonce je Request, ADR-008) und von Proxies/CDN nicht umschreiben lassen
 * (`no-transform`: z. B. keine eingeschleusten Skripte ohne Nonce). Next übernimmt einen bereits gesetzten
 * `Cache-Control` beim Rendern (send-payload: „don't override … to allow users to customize it“).
 */
export const HTML_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate, no-transform";

/** Dokument-Navigation des Browsers (nicht RSC-/Daten-Requests, die kein HTML liefern). */
export function isDocumentRequest(headers: Headers): boolean {
  return (headers.get("accept") ?? "").includes("text/html") && !headers.has("rsc");
}

/** Laufzeitabhängige Header für HTML-Antworten (zusätzlich zur CSP). */
export function pageSecurityHeaders(env: Pick<WebEnv, "httpsOrigin" | "searchIndexing">): [string, string][] {
  const headers: [string, string][] = [];
  if (env.httpsOrigin) headers.push(["Strict-Transport-Security", HSTS_VALUE]);
  // ADR-030: vorerst noindex, solange SEARCH_INDEXING nicht aktiv ist.
  if (!env.searchIndexing) headers.push(["X-Robots-Tag", "noindex, nofollow"]);
  return headers;
}
