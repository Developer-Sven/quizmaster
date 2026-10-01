import { connection } from "next/server";
import { ErrorView } from "@/components/app/error-view";
import { de } from "@/i18n/de";

/**
 * Globale 404-Seite (docs/09 §6: `EmptyState` + „Zur Startseite“) für unbekannte Pfade und `notFound()`
 * ohne eigene not-found-Datei. Dynamisch gerendert (`connection()`, zusätzlich zum Wurzel-Layout), damit
 * Nexts Skripte die CSP-Nonce tragen (ADR-008).
 */
export default async function NotFound() {
  await connection();
  return <ErrorView testId="not-found" message={de.pages.notFound} />;
}
