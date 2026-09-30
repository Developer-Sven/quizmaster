"use client";

import { de } from "../../i18n/de";
import type { CategoryVisual } from "../../lib/ui/category";
import { cx } from "../../lib/ui/cx";
import type { ForcedStateProps } from "../../lib/ui/forced-state";
import { CategoryIcon } from "./category-icon";

export interface CategoryTileProps extends ForcedStateProps {
  category: CategoryVisual;
  /** gewählt: 2 px Rahmen `primary` */
  selected?: boolean;
  /** 2-px-Orange-Rahmen ohne Auswahl – der wandernde Rahmen für Zuschauende (docs/09 §7.2) */
  highlighted?: boolean;
  /** Für Zuschauende: nicht bedienbar, keine Hover-/Druck-Effekte */
  viewOnly?: boolean;
  onSelect?: () => void;
  /** Tastenkürzel für Screenreader, z. B. „1“ (Kategorien 1–3, docs/09 §12) */
  shortcut?: string;
}

const tileClasses = "flex h-22 w-full items-center gap-4 rounded-lg border-2 bg-surface-2 px-4 text-left";

/**
 * CategoryTile (docs/09 §5): Höhe 88, `surface-2`, Icon-Kachel 48 · Name im Stil `title`.
 * Zustände: idle, pressed, selected, view-only.
 */
export function CategoryTile({
  category,
  selected = false,
  highlighted = false,
  viewOnly = false,
  onSelect,
  shortcut,
  ...rest
}: CategoryTileProps) {
  const border = selected || highlighted ? "border-primary" : "border-transparent";
  const content = (
    <>
      <CategoryIcon icon={category.icon} color={category.color} frame="tile" />
      <span className="line-clamp-2 min-w-0 flex-1 text-title text-text">{category.name}</span>
      {selected && viewOnly ? <span className="sr-only">{de.a11y.selected}</span> : null}
    </>
  );

  if (viewOnly) {
    return <div className={cx(tileClasses, border, "transition-control")}>{content}</div>;
  }

  return (
    <button
      {...rest}
      type="button"
      aria-pressed={selected}
      aria-keyshortcuts={shortcut}
      onClick={onSelect}
      className={cx(
        tileClasses,
        border,
        "select-none touch-manipulation transition-control motion-safe:is-pressed:scale-98 is-hover:bg-surface-3 is-pressed:bg-surface-3 is-focus:outline-2 is-focus:outline-offset-2 is-focus:outline-primary",
      )}
    >
      {content}
    </button>
  );
}
