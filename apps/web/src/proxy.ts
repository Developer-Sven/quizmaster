/**
 * Proxy (Next 16, ersetzt middleware.ts): pro Request eine neue Nonce, CSP exakt nach docs/06 (ADR-008)
 * und laufzeitabhängige Sicherheitsheader (HSTS nur bei https-APP_ORIGIN, noindex bis SEARCH_INDEXING).
 * Next liest die Nonce aus dem Request-Header `Content-Security-Policy` und versieht damit seine Skripte –
 * das wirkt nur bei dynamisch gerenderten Seiten (siehe `getPublicRuntimeConfig`/`getRequestNonce`).
 * Env-unabhängige Header setzt `next.config.ts`.
 */
import { type NextRequest, NextResponse } from "next/server";
import { getWebEnv } from "./env";
import {
  buildContentSecurityPolicy,
  createNonce,
  HTML_CACHE_CONTROL,
  isDocumentRequest,
  NONCE_HEADER,
  pageSecurityHeaders,
} from "./lib/server/security-headers";

export function proxy(request: NextRequest): NextResponse {
  const env = getWebEnv();
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy(nonce, env);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  for (const [name, value] of pageSecurityHeaders(env)) response.headers.set(name, value);
  if (isDocumentRequest(request.headers)) response.headers.set("Cache-Control", HTML_CACHE_CONTROL);
  return response;
}

export const config = {
  matcher: [
    {
      /*
       * Alle Seiten – außer API-Routen (JSON, eigene strikte CSP aus next.config.ts), statischen Next-Assets,
       * Service Worker, Flaggen und Dateien mit Endung (Icons, Manifest, robots.txt …).
       */
      source:
        "/((?!api(?:/|$)|_next/static|_next/image|sw\\.js|flags/|.*\\.(?:ico|png|svg|jpg|jpeg|gif|webp|avif|txt|xml|json|webmanifest|js|css|map|woff2?)$).*)",
      // Prefetches (next/link) liefern kein HTML → keine Nonce nötig (Next-CSP-Leitfaden).
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
