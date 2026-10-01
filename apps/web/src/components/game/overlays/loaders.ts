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
