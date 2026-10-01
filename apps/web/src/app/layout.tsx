import type { Metadata, Viewport } from "next";
import { Rubik } from "next/font/google";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { PwaRegistrar } from "@/components/pwa/pwa-registrar";
import { de } from "../i18n/de";
import { THEME_COLOR } from "../lib/ui/tokens";
import "./globals.css";

/** Einzige Schrift (docs/09 §3): Rubik, selbst gehostet über next/font, als Variable für `--font-sans`. */
const rubik = Rubik({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-rubik",
});

/**
 * Metadaten inkl. PWA (docs/10): Das Manifest verlinkt Next aus `app/manifest.ts`. iOS: als Web-App startbar,
 * Statusleiste durchscheinend (Inhalt reicht darunter – Safe Areas über `pt-safe`), Home-Bildschirm-Icon
 * 180 × 180 ohne Transparenz. Favicon als SVG mit ICO-Rückfall (Icons: `scripts/generate-icons.ts`).
 */
export const metadata: Metadata = {
  title: de.app.name,
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
};

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
