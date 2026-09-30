import type { CSSProperties } from "react";

/** Ein Eintrag für {@link cx}: falsy-Werte fallen weg (z. B. `isActive && "bg-surface-3"`). */
export type ClassValue = string | false | null | undefined;

/**
 * Setzt Klassen aus Klassen-Maps zusammen (ohne Zusatzpaket). Es gibt keine Konfliktauflösung:
 * Die Maps einer Komponente dürfen sich nicht überschneiden.
 */
export function cx(...values: readonly ClassValue[]): string {
  let result = "";
  for (const value of values) {
    if (value) result = result ? `${result} ${value}` : value;
  }
  return result;
}

/**
 * Inline-Style nur mit CSS-Variablen aus Daten – die einzige erlaubte Form von `style` außerhalb
 * von motion (docs/09 Regel 9), z. B. `{ "--cat": category.color }`.
 */
export type CssVariables = CSSProperties & Readonly<Record<`--${string}`, string>>;
