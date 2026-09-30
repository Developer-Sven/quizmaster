"use client";

import type { ComponentPropsWithRef, MouseEvent } from "react";
import { cx } from "../../lib/ui/cx";
import type { ForcedStateProps } from "../../lib/ui/forced-state";
import type { LucideIcon } from "../../lib/ui/icons";

export interface IconButtonProps
  extends ForcedStateProps,
    Omit<ComponentPropsWithRef<"button">, "className" | "style" | "children" | "aria-label" | "title"> {
  icon: LucideIcon;
  /** Pflicht: Name für Screenreader (`aria-label`) und Tooltip am Desktop (`title`) */
  label: string;
  /** Umschalter (z. B. Bewertung): aktiv orange, setzt `aria-pressed` */
  pressed?: boolean;
}

/**
 * IconButton (docs/09 §5): 44 × 44 mit 48-px-Trefferfläche, Icon 24, Zustände wie Button (ghost).
 * Deaktiviert per `aria-disabled` – bleibt fokussierbar (z. B. Stepper an der Grenze).
 */
export function IconButton({
  icon: Icon,
  label,
  pressed,
  disabled = false,
  type = "button",
  onClick,
  ...rest
}: IconButtonProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      onClick={handleClick}
      className={cx(
        "relative inline-flex size-11 shrink-0 items-center justify-center rounded-lg select-none touch-manipulation transition-control before:absolute before:-inset-0.5 motion-safe:is-pressed:scale-98 is-hover:bg-surface-2 is-pressed:bg-surface-3 is-focus:outline-2 is-focus:outline-offset-2 is-focus:outline-primary aria-disabled:cursor-not-allowed aria-disabled:opacity-40",
        pressed ? "text-primary" : "text-text",
      )}
    >
      <Icon size={24} />
    </button>
  );
}
