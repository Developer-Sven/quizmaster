import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { PwaRegistrar } from "@/components/pwa/pwa-registrar";
import { getWebEnv } from "../env";
import { rootMetadata } from "../lib/server/site-metadata";
import { THEME_COLOR } from "../lib/ui/tokens";
import { rubik } from "./fonts";
import "./globals.css";

/**
 * Metadaten inkl. PWA (docs/10, `lib/server/site-metadata.ts`): Titel „quizmaster“ mit Vorlage für Unterseiten,
 * Beschreibung wie im Manifest, iOS-/Icon-Angaben; das Manifest verlinkt Next aus `app/manifest.ts`. Das
 * robots-Meta-Tag (`noindex, nofollow`, solange `SEARCH_INDEXING` aus ist – ADR-030) hängt an der Laufzeit-Env:
 * erst `connection()` (der Build läuft ohne Env und rendert keine Seite vor), dann die Env.
 */
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  return rootMetadata(getWebEnv());
}

/** Viewport und Theme-Color (docs/10): `viewport-fit=cover` für die Safe Areas im Standalone-Modus. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: THEME_COLOR,
  colorScheme: "dark",
};

/**
 * Wurzel-Layout. `await connection()` macht ALLE HTML-Seiten dynamisch – auch `/_not-found` und Seiten, die
 * beim Build `notFound()` werfen (/dev/* in Produktion): Next versieht seine Skripte nur beim Rendern pro
 * Request mit der CSP-Nonce aus `proxy.ts` (ADR-008, Next-CSP-Leitfaden „all pages must be dynamically
 * rendered“). Statisch vorgerendertes HTML hätte Skripte ohne Nonce, die die CSP blockiert.
 * `PwaRegistrar` registriert den Service Worker und fängt `beforeinstallprompt` ab (docs/10).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="de" className={rubik.variable}>
      <body className="min-h-dvh bg-bg text-body text-text antialiased">
        {children}
        <PwaRegistrar />
      </body>
    </html>
  );
}
