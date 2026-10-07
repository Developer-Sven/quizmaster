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

const tileClasses = "@container flex min-h-22 w-full items-center rounded-lg border-2 bg-surface-2 px-4 py-3 text-left";

/**
 * CategoryTile (docs/09 §5): Höhe 88, `surface-2`, Icon-Kachel 48 · Name im Stil `title`.
 * Zustände: idle, pressed, selected, view-only.
 *
 * Der Name wird nie abgeschnitten (docs/09 §12, WCAG 1.4.4 – wer wählt, muss ihn lesen können): Er trennt bzw. bricht
 * um, und die Kachel wächst bei großer Schrift über 88 px hinaus (bei 100 % bleibt sie 88 hoch). In einer schmalen
 * Kachel (unter 18 rem, also bei großer Schrift auf dem Handy) steht die Icon-Kachel über dem Namen – so bekommt er
 * die ganze Breite und bricht zwischen den Wörtern um statt mitten im Wort.
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
    <span className="flex w-full min-w-0 items-center gap-4 @max-2xs:flex-col @max-2xs:items-start @max-2xs:gap-3">
      <CategoryIcon icon={category.icon} color={category.color} frame="tile" />
      <span className="min-w-0 max-w-full flex-1 text-title text-text hyphens-auto wrap-break-word">
        {category.name}
      </span>
      {selected && viewOnly ? <span className="sr-only">{de.a11y.selected}</span> : null}
    </span>
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
