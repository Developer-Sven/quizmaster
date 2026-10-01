import type { Metadata, Viewport } from "next";
import { Rubik } from "next/font/google";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { de } from "../i18n/de";
import { THEME_COLOR } from "../lib/ui/tokens";
import "./globals.css";

/** Einzige Schrift (docs/09 §3): Rubik, selbst gehostet über next/font, als Variable für `--font-sans`. */
const rubik = Rubik({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-rubik",
});

export const metadata: Metadata = {
  title: de.app.name,
};

/** Viewport und Theme-Color (docs/10); weitere PWA-Metadaten ergänzt die PWA-Phase. */
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
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="de" className={rubik.variable}>
      <body className="min-h-dvh bg-bg text-body text-text antialiased">{children}</body>
    </html>
  );
}
