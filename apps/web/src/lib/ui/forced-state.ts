/**
 * Nur für /dev/ui: erzwingt einen Interaktionszustand statisch, damit jede Komponente in allen
 * Zuständen sichtbar ist (docs/09 §5, §13). Wirkt über die `is-*`-Varianten in globals.css.
 */
export type ForcedState = "hover" | "pressed" | "focus";

export interface ForcedStateProps {
  "data-force"?: ForcedState;
}
