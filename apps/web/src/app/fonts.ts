import { Rubik } from "next/font/google";

/**
 * Einzige Schrift (docs/09 §3): Rubik, selbst gehostet über next/font, als Variable für `--font-sans`. An genau
 * einer Stelle definiert – Wurzel-Layout und globale Fehlerseite teilen so eine Instanz (sonst entstünde eine
 * zweite, auf jeder Seite geladene Schrift-CSS mit denselben `@font-face`-Regeln; next/font-Doku
 * „Using a font definitions file“).
 *
 * `subsets` legt nur fest, was VORGELADEN wird (next/font-Doku „subsets“): Die `@font-face`-Regeln aller
 * Teilmengen bleiben mit `unicode-range` in der CSS, der Browser lädt eine Teilmenge, sobald ein Zeichen daraus
 * erscheint. `latin` deckt alle UI-Texte ab (ä ö ü ß, „“ – …: U+0000–00FF, U+2000–206F). `latin-ext` (≈ 20 KB)
 * vorab zu laden kostete jede Seite LCP (docs/perf-report); die Lobby lädt es im Hintergrund nach
 * (`lib/client/font-preload.ts`) – für Fragen und Namen mit ō, ł, ć, š …
 */
export const rubik = Rubik({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-rubik",
});
