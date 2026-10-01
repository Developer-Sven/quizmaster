/**
 * Vorladen der Spiel-Overlays (docs/07 §Code-Splitting): Sie liegen in eigenen Chunks (`dynamic()` in
 * der Stage) und werden beim Betreten der Lobby alle geladen, damit im Spiel nichts nachgeladen wird.
 * Das `ConnectionOverlay` gehört ins Haupt-Bundle und fehlt hier bewusst.
 */
const loaders = [
  () => import("./intro-overlay"),
  () => import("./category-pick-overlay"),
  () => import("./category-reveal-overlay"),
  () => import("./question-overlay"),
  () => import("./answer-reveal-overlay"),
  () => import("./turn-summary-overlay"),
  () => import("./round-board-overlay"),
  () => import("./game-over-overlay"),
  () => import("../review-sheet"),
] as const;

let started = false;

/** Lädt alle Overlay-Chunks einmal pro Seite (Fehler nur loggen – `dynamic()` lädt sonst bei Bedarf). */
export function preloadOverlays(): void {
  if (started) return;
  started = true;
  for (const load of loaders) {
    load().catch((error: unknown) => {
      console.warn("Overlay konnte nicht vorgeladen werden:", error instanceof Error ? error.name : "unbekannt");
    });
  }
}
