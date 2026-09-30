/**
 * Token-Spiegel für Stellen ohne CSS-Zugriff: Meta-Theme-Color/Manifest, QR-Code-Bild und motion.
 * Quelle der Wahrheit bleibt src/app/globals.css (docs/09 §2) – tokens.test.ts prüft die Gleichheit
 * (auch für `PLAYER_COLOR_HEX` aus @quizmaster/shared). Komponenten stylen nie mit diesen Werten,
 * sondern mit den Token-Klassen.
 */

/** Studio-Navy (`--color-bg`) für `viewport.themeColor` und das Web-App-Manifest (docs/10). */
export const THEME_COLOR = "#0B1426";

/** QR-Code als Data-URL-Bild: dunkle Module in `bg`, heller Grund in `text` (gut scanbar). */
export const QR_CODE_COLORS = { dark: "#0B1426", light: "#F4F7FC" } as const;

/** Dauer-Tokens in Millisekunden (`--duration-*`). */
export const DURATION_MS = { fast: 120, base: 200, slow: 320, overlay: 480 } as const;

/** Kubische Bézier-Kurven (`--ease-*`) als Tupel für motion. */
export const EASING = {
  standard: [0.2, 0, 0, 1],
  emphasized: [0.3, 0, 0, 1],
  exit: [0.4, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Staffelungen aus docs/09 §7–8 in Millisekunden. */
export const STAGGER_MS = {
  /** Gestaffelte Listen (Antworten, Kacheln) */
  list: 40,
  /** Personen (Avatare im Intro) */
  people: 60,
  /** Avatare an der gewählten Antwort */
  pickers: 50,
  /** Ergebnis-Kästchen im Zug-Ergebnis und auf der Tafel */
  squares: 80,
  /** Podest-Säulen */
  podium: 160,
} as const;

/** Anzeigedauer eines Toasts (docs/09 §5). */
export const TOAST_DURATION_MS = 3_000;

/** Verschiebung beim Einblenden bzw. Ausblenden von Screens/Overlays in px (docs/09 §8). */
export const OFFSET_PX = { enter: 12, exit: 8, float: 16 } as const;

/** Millisekunden → Sekunden (motion erwartet Sekunden). */
export function seconds(ms: number): number {
  return ms / 1000;
}
