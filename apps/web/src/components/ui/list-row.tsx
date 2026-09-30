"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "../../lib/ui/cx";
import type { ForcedStateProps } from "../../lib/ui/forced-state";
import { CheckIcon, type LucideIcon } from "../../lib/ui/icons";

export interface ListRowProps extends ForcedStateProps {
  children: ReactNode;
  /** optionales Icon links, 20 px */
  icon?: LucideIcon;
  /** ausgewählt: `check` rechts, `aria-pressed` */
  selected?: boolean;
  /** Zeile als Button */
  onClick?: () => void;
  /** Zeile als Link (hat Vorrang vor `onClick`) */
  href?: string;
  disabled?: boolean;
}

// Die Zeile reicht 12 px in den Seitenrand, damit der Text bündig zur Spalte steht und die
// Druckfläche trotzdem Luft hat.
const rowClasses =
  "box-content -mx-3 flex min-h-14 w-full items-center gap-3 border-b border-line px-3 text-left text-body text-text";

const interactiveClasses =
  "select-none touch-manipulation transition-control is-hover:bg-surface-2 is-pressed:bg-surface-3 is-focus:outline-2 is-focus:-outline-offset-2 is-focus:outline-primary aria-disabled:cursor-not-allowed aria-disabled:opacity-40";

/**
 * ListRow (docs/09 §5): Höhe 56, optional Icon 20 links, Text `body`, Trennlinie `line`.
 * Zustände: pressed, selected (`check` rechts). Als Button (`onClick`), Link (`href`) oder statisch.
 */
export function ListRow({ children, icon: Icon, selected, onClick, href, disabled = false, ...rest }: ListRowProps) {
  const content = (
    <>
      {Icon ? <Icon size={20} className="shrink-0 text-text-2" /> : null}
      <span className="min-w-0 flex-1">{children}</span>
      {selected ? <CheckIcon size={20} className="shrink-0 text-primary" /> : null}
    </>
  );

  if (href !== undefined) {
    return (
      <Link {...rest} href={href} className={cx(rowClasses, interactiveClasses)}>
        {content}
      </Link>
    );
  }

  if (onClick !== undefined) {
    return (
      <button
        {...rest}
        type="button"
        aria-pressed={selected}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) onClick();
        }}
        className={cx(rowClasses, interactiveClasses)}
      >
        {content}
      </button>
    );
  }

  return <div className={rowClasses}>{content}</div>;
}
