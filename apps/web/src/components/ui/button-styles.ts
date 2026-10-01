import { cx } from "../../lib/ui/cx";

/**
 * Klassen des Buttons (docs/09 §5) ohne Client-Code: `Button`/`ButtonLink` (button.tsx) bauen darauf auf, die
 * Fehlerseiten (app/error.tsx, app/global-error.tsx, ErrorView) nutzen sie für schlichte `<button>`/`<a>` – so
 * sehen sie gleich aus, ohne `next/link`, das Button-Modul und dessen Icons in die Fehler-Chunks zu ziehen, die
 * mit dem Layout auf jeder Seite laden (docs/07 Initial-JS).
 */

/** primary = die eine orange Hauptaktion pro Screen (docs/09 Regel 8). */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

/** Höhe 56 (Standard) oder 44 (kompakt, mit 48-px-Trefferfläche). */
export type ButtonSize = "default" | "compact";

/** Deaktiviert = 40 % Deckkraft; lädt = volle Deckkraft mit Warte-Cursor (beide nicht bedienbar). */
export type ButtonActivity = "active" | "disabled" | "loading";

const baseClasses =
  "relative inline-flex min-w-0 items-center justify-center gap-2 rounded-lg text-button select-none touch-manipulation transition-control motion-safe:is-pressed:scale-98 is-focus:outline-2 is-focus:outline-offset-2 is-focus:outline-primary";

const variantClasses: Record<ButtonVariant, string> = {
  // Transparenter Rahmen: im Kontrastmodus (forced colors) wird die Fläche zu Canvas – der Rahmen in Systemfarbe
  // bleibt und zeigt die Hauptaktion als Button (WCAG 1.4.11, docs/09 §12); sonst unsichtbar, Höhe unverändert.
  primary: "border border-transparent bg-primary text-on-primary is-hover:bg-primary-hover is-pressed:bg-primary-press",
  secondary: "border border-line-strong bg-surface-2 text-text is-hover:bg-surface-3 is-pressed:bg-surface-3",
  ghost: "text-text is-hover:bg-surface-2 is-pressed:bg-surface-3",
  // Fläche bleibt surface-2 (Rot darauf 4,7:1); Hover/Druck zeigen sich am Rahmen
  destructive: "border border-line-strong bg-surface-2 text-danger is-hover:border-danger is-pressed:border-danger",
};

/** Mindesthöhe statt fester Höhe: Bei Text-Zoom bricht die Beschriftung um und der Button wächst (WCAG 1.4.4). */
const sizeClasses: Record<ButtonSize, string> = {
  default: "min-h-14 px-6 py-2",
  compact: "min-h-11 px-4 py-2 before:absolute before:inset-x-0 before:-inset-y-0.5",
};

const activityClasses: Record<ButtonActivity, string> = {
  active: "",
  disabled: "cursor-not-allowed opacity-40",
  loading: "cursor-wait",
};

/** Beschriftung: zentriert, bricht bei Bedarf um (zur Not im Wort) statt mit Ellipse abgeschnitten zu werden. */
export const BUTTON_LABEL_CLASSES = "min-w-0 text-center wrap-break-word";

export function buttonClasses(
  variant: ButtonVariant,
  size: ButtonSize = "default",
  block = false,
  activity: ButtonActivity = "active",
): string {
  return cx(baseClasses, variantClasses[variant], sizeClasses[size], block && "w-full", activityClasses[activity]);
}
