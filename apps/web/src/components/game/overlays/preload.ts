/**
 * Vorladen der Spiel-Overlays (docs/07 §Code-Splitting): Sie liegen in eigenen Chunks und werden beim
 * Betreten der Lobby alle geladen, damit im Spiel nichts nachgeladen wird. Dieselben Loader nutzt `dynamic()`
 * in Stage und LiveGame (`loaders.ts`) – nur so trifft das Vorladen genau die Chunks des Spiels. Geladene
 * Module rendert die Bühne danach synchron (`preloadedOverlays`).
 * Das `ConnectionOverlay` gehört ins Haupt-Bundle und fehlt hier bewusst.
 */
import { loadOverlay, type OverlayName, overlayLoaders } from "./loaders";

let started = false;

/** Lädt alle Overlay-Chunks einmal pro Seite (Fehler nur loggen – `dynamic()` lädt sonst bei Bedarf). */
export function preloadOverlays(): void {
  if (started) return;
  started = true;
  for (const name of Object.keys(overlayLoaders) as OverlayName[]) {
    loadOverlay(name).catch((error: unknown) => {
      console.warn("Overlay konnte nicht vorgeladen werden:", error instanceof Error ? error.name : "unbekannt");
    });
  }
}
