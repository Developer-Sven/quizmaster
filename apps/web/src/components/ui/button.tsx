"use client";

import Link from "next/link";
import type { ComponentPropsWithRef, MouseEvent, ReactNode } from "react";
import type { ForcedStateProps } from "../../lib/ui/forced-state";
import { LoaderCircleIcon, type LucideIcon } from "../../lib/ui/icons";
import { BUTTON_LABEL_CLASSES, type ButtonSize, type ButtonVariant, buttonClasses } from "./button-styles";

export type { ButtonSize, ButtonVariant } from "./button-styles";

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
 * Die Beschriftung wird nie abgeschnitten: Reicht die Breite nicht (Text-Zoom), bricht sie zentriert um.
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
      <span className={BUTTON_LABEL_CLASSES}>{children}</span>
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
      <span className={BUTTON_LABEL_CLASSES}>{children}</span>
    </Link>
  );
}
