"use client";

import Link from "next/link";
import type { ComponentPropsWithRef, MouseEvent, ReactNode } from "react";
import { cx } from "../../lib/ui/cx";
import type { ForcedStateProps } from "../../lib/ui/forced-state";
import { LoaderCircleIcon, type LucideIcon } from "../../lib/ui/icons";

/** primary = die eine orange Hauptaktion pro Screen (docs/09 Regel 8). */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

/** Höhe 56 (Standard) oder 44 (kompakt, mit 48-px-Trefferfläche). */
export type ButtonSize = "default" | "compact";

const baseClasses =
  "relative inline-flex min-w-0 items-center justify-center gap-2 rounded-lg text-button select-none touch-manipulation transition-control motion-safe:is-pressed:scale-98 is-focus:outline-2 is-focus:outline-offset-2 is-focus:outline-primary";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary is-hover:bg-primary-hover is-pressed:bg-primary-press",
  secondary: "border border-line-strong bg-surface-2 text-text is-hover:bg-surface-3 is-pressed:bg-surface-3",
  ghost: "text-text is-hover:bg-surface-2 is-pressed:bg-surface-3",
  // Fläche bleibt surface-2 (Rot darauf 4,7:1); Hover/Druck zeigen sich am Rahmen
  destructive: "border border-line-strong bg-surface-2 text-danger is-hover:border-danger is-pressed:border-danger",
};

const sizeClasses: Record<ButtonSize, string> = {
  default: "h-14 px-6",
  compact: "h-11 px-4 before:absolute before:inset-x-0 before:-inset-y-0.5",
};

/** Deaktiviert = 40 % Deckkraft; lädt = volle Deckkraft mit Warte-Cursor (beide nicht bedienbar). */
type ButtonActivity = "active" | "disabled" | "loading";

const activityClasses: Record<ButtonActivity, string> = {
  active: "",
  disabled: "cursor-not-allowed opacity-40",
  loading: "cursor-wait",
};

function buttonClasses(variant: ButtonVariant, size: ButtonSize, block: boolean, activity: ButtonActivity): string {
  return cx(baseClasses, variantClasses[variant], sizeClasses[size], block && "w-full", activityClasses[activity]);
}

interface ButtonStyleProps extends ForcedStateProps {
  variant: ButtonVariant;
  size?: ButtonSize;
  /** Icon links, 20 px */
  icon?: LucideIcon;
  /** volle Breite (Aktionsleiste, Dialog) */
  block?: boolean;
  children: ReactNode;
}

export interface ButtonProps
  extends ButtonStyleProps,
    Omit<ComponentPropsWithRef<"button">, "className" | "style" | "children"> {
  /** `loader-circle` dreht, der Text bleibt; der Button ist dann nicht bedienbar */
  loading?: boolean;
}

/**
 * Button (docs/09 §5): Höhe 56 bzw. 44, `radius-lg`, Text `button`, optional Icon links.
 * Deaktiviert per `aria-disabled` (bleibt fokussierbar, Klicks wirken nicht), damit der Fokus nicht verloren geht.
 */
export function Button({
  variant,
  size = "default",
  icon: Icon,
  block = false,
  loading = false,
  disabled = false,
  type = "button",
  onClick,
  children,
  ...rest
}: ButtonProps) {
  const inactive = disabled || loading;
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (inactive) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      {...rest}
      type={type}
      aria-disabled={inactive || undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
      className={buttonClasses(variant, size, block, disabled ? "disabled" : loading ? "loading" : "active")}
    >
      {loading ? (
        <LoaderCircleIcon size={20} className="shrink-0 animate-spin motion-reduce:animate-none" />
      ) : Icon ? (
        <Icon size={20} className="shrink-0" />
      ) : null}
      <span className="truncate">{children}</span>
    </button>
  );
}

export interface ButtonLinkProps
  extends ButtonStyleProps,
    Omit<ComponentPropsWithRef<typeof Link>, "className" | "style" | "children"> {}

/** Navigation im Button-Look (z. B. „Zur Startseite“ auf Fehlerseiten), gleiche Varianten wie {@link Button}. */
export function ButtonLink({
  variant,
  size = "default",
  icon: Icon,
  block = false,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link {...rest} className={buttonClasses(variant, size, block, "active")}>
      {Icon ? <Icon size={20} className="shrink-0" /> : null}
      <span className="truncate">{children}</span>
    </Link>
  );
}
