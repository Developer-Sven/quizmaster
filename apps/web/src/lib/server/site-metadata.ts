/**
 * Seiten-Metadaten und robots.txt (docs/10 Metadaten, ADR-030: vorerst privat). Solange `SEARCH_INDEXING` aus
 * ist (Standard), verbieten robots.txt (`Disallow: /`), das robots-Meta-Tag (`noindex, nofollow`) und der Header
 * `X-Robots-Tag` (proxy.ts) Crawlen und Indexieren. Mit `SEARCH_INDEXING=true` sind Startseite und Regeln
 * freigegeben; Lobbys, Kurzlinks, API, Entwicklungs- und Offline-Seite bleiben gesperrt (Lobby, Kurzlink und
 * Offline-Seite tragen zusätzlich eigenes `noindex`).
 *
 * Reine Funktionen – `app/layout.tsx` (`generateMetadata`) und `app/robots.ts` lesen die Env zur Laufzeit
 * (ADR-023): Der Build läuft ohne Env, ein beim Build festgeschriebener Wert wäre nach dem Umschalten falsch.
 */
import type { Metadata, MetadataRoute } from "next";
import type { WebEnv } from "../../env";
import { de } from "../../i18n/de";

type IndexingEnv = Pick<WebEnv, "searchIndexing">;

/**
 * Für Crawler gesperrt, auch wenn die Indexierung an ist: private, kurzlebige oder technische Pfade. Ordner mit
 * Schrägstrich am Ende – sonst sperrte z. B. `/j` auch künftige Seiten wie `/jahr`.
 */
export const CRAWL_DISALLOWED_PATHS = ["/lobby/", "/j/", "/api/", "/dev/", "/offline"] as const;

/** Inhalt von `/robots.txt`. */
export function robotsFile(env: IndexingEnv): MetadataRoute.Robots {
  if (!env.searchIndexing) return { rules: { userAgent: "*", disallow: "/" } };
  return { rules: { userAgent: "*", allow: "/", disallow: [...CRAWL_DISALLOWED_PATHS] } };
}

/** robots-Meta-Tag aller Seiten: `noindex, nofollow`, solange die Indexierung aus ist; sonst keins (Standard). */
export function robotsMetadata(env: IndexingEnv): Metadata["robots"] {
  return env.searchIndexing ? undefined : { index: false, follow: false };
}

/**
 * Metadaten des Wurzel-Layouts: Titel „quizmaster“ (Unterseiten „Regeln – quizmaster“), Beschreibung wie im
 * Manifest, PWA-Angaben für iOS (docs/10: als Web-App startbar, durchscheinende Statusleiste – Safe Areas über
 * `pt-safe`), Favicon als SVG mit ICO-Rückfall, Home-Bildschirm-Icon 180 × 180 ohne Transparenz
 * (`scripts/generate-icons.ts`), robots-Meta-Tag nach `SEARCH_INDEXING`.
 */
export function rootMetadata(env: IndexingEnv): Metadata {
  const robots = robotsMetadata(env);
  return {
    title: { default: de.app.name, template: `%s – ${de.app.name}` },
    description: de.pwa.manifest.description,
    applicationName: de.app.name,
    appleWebApp: { capable: true, title: de.app.name, statusBarStyle: "black-translucent" },
    icons: {
      icon: [
        { url: "/icons/favicon.ico", sizes: "32x32" },
        { url: "/icons/favicon.svg", type: "image/svg+xml" },
      ],
      apple: [{ url: "/icons/apple-icon-180.png", sizes: "180x180", type: "image/png" }],
    },
    ...(robots === undefined ? {} : { robots }),
  };
}
