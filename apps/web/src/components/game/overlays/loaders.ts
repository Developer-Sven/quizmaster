/**
 * Die einzige Lade-Stelle der Spiel-Overlays und von „Fragen ansehen“ (docs/07 §Code-Splitting): `dynamic()`
 * in Stage/LiveGame und `preloadOverlays()` rufen dieselben `import()` auf. So entsteht je Overlay genau EIN
 * Chunk – das Vorladen beim Betreten der Lobby lädt genau den Code, den das Spiel später rendert, und im Spiel
 * wird nichts nachgeladen. (Getrennte `import()` in `dynamic()` und im Vorladen ergaben unter Turbopack je
 * Overlay zwei Chunk-Kopien – das Vorladen war wirkungslos.)
 */
export const overlayLoaders = {
  intro: () => import("./intro-overlay"),
  categoryPick: () => import("./category-pick-overlay"),
  categoryReveal: () => import("./category-reveal-overlay"),
  question: () => import("./question-overlay"),
  answerReveal: () => import("./answer-reveal-overlay"),
  turnSummary: () => import("./turn-summary-overlay"),
  roundBoard: () => import("./round-board-overlay"),
  gameOver: () => import("./game-over-overlay"),
  reviewSheet: () => import("../review-sheet"),
} as const;

export type OverlayName = keyof typeof overlayLoaders;

export type OverlayModules = { [K in OverlayName]: Awaited<ReturnType<(typeof overlayLoaders)[K]>> };

/** Bereits geladene Overlay-Module (nach dem Vorladen). */
const loaded: Partial<OverlayModules> = {};

/** Lädt ein Overlay-Modul (gleicher Chunk wie `dynamic()`) und merkt es sich für das synchrone Rendern. */
export function loadOverlay<K extends OverlayName>(name: K): Promise<OverlayModules[K]> {
  const pending = overlayLoaders[name]() as Promise<OverlayModules[K]>;
  return pending.then((module) => {
    loaded[name] = module;
    return module;
  });
}

/**
 * Momentaufnahme der schon geladenen Module. Die Bühne rendert ein vorgeladenes Overlay damit synchron:
 * `dynamic()` (React.lazy) würde beim ersten Einhängen sonst einmal „suspendieren“, und React gibt den
 * fertigen Inhalt dann erst gedrosselt frei (bis ~300 ms) – das erste Intro, die erste Kategorie-Einblendung,
 * Rundentafel und Spielende kamen so zu spät und ihre Choreografie lief nicht synchron.
 */
export function preloadedOverlays(): Partial<OverlayModules> {
  return { ...loaded };
}
