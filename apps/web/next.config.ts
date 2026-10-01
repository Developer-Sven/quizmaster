import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

function findRepoRoot(start: string): string {
  let dir = start;
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
  return dir;
}

const repoRoot = findRepoRoot(process.cwd());

/**
 * Env-unabhängige Sicherheitsheader für ALLE Antworten (docs/06 §HTTP-Sicherheitsheader). Die CSP mit Nonce,
 * HSTS (nur bei https-APP_ORIGIN) und X-Robots-Tag setzt `src/proxy.ts` zur Laufzeit – `headers()` wird beim
 * Build ausgewertet und darf daher keine Env lesen.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  },
];

/** JSON-API: nichts ausführen/einbetten, nie indexieren. */
const API_HEADERS = [
  { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

/** Service Worker: immer frisch prüfen (docs/06, docs/10). */
const SERVICE_WORKER_HEADERS = [
  { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
  { key: "Content-Type", value: "application/javascript; charset=utf-8" },
];

/**
 * Web-App-Manifest (app/manifest.ts, docs/10): immer revalidieren, nie lange im CDN – Name, Icons und Kurzbefehle
 * sollen nach einem Deploy sofort gelten (entspricht Nexts Standard für Metadaten-Routen, hier festgeschrieben).
 */
const MANIFEST_HEADERS = [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }];

const nextConfig: NextConfig = {
  reactCompiler: true,
  poweredByHeader: false,
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  transpilePackages: ["@quizmaster/shared", "@quizmaster/db"],
  // Eigenes Build-Verzeichnis je paralleler Instanz (z. B. Agents/E2E), Standard .next
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Schrift-Preloads als `<link rel="preload">` im HTML statt als `Link`-Header: React fügt beim Hydrieren
  // (Ressourcen-Hinweise im RSC-Payload) sonst ein zweites Preload ein. Ohne Service Worker verschmilzt
  // Chromium beide; kommt die Seite aus dem SW, lädt es jede Schrift doppelt und warnt „preloaded … but not
  // used“. Mit dem Tag im HTML findet React sein Preload schon vor und legt kein zweites an.
  reactMaxHeadersLength: 0,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      { source: "/api/:path*", headers: API_HEADERS },
      { source: "/sw.js", headers: SERVICE_WORKER_HEADERS },
      { source: "/manifest.webmanifest", headers: MANIFEST_HEADERS },
    ];
  },
};

export default nextConfig;
