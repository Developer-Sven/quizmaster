import { Rubik } from "next/font/google";

/**
 * Einzige Schrift (docs/09 §3): Rubik, selbst gehostet über next/font, als Variable für `--font-sans`. An genau
 * einer Stelle definiert – Wurzel-Layout und globale Fehlerseite teilen so eine Instanz (sonst entstünde eine
 * zweite, auf jeder Seite geladene Schrift-CSS mit denselben `@font-face`-Regeln; next/font-Doku
 * „Using a font definitions file“).
 */
export const rubik = Rubik({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-rubik",
});
