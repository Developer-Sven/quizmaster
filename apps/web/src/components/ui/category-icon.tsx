import { categoryColorStyle, categoryIconFor } from "../../lib/ui/category";
import type { IconSize } from "../../lib/ui/icons";

/**
 * - `none`: nur das Icon in Kategoriefarbe
 * - `tile`: Icon-Kachel 48 × 48 (`radius-md`), Fläche `bg` mit 1 px `line`, Icon 24 in Kategoriefarbe
 * - `reveal`: Reveal-Kachel 96 × 96 (`radius-xl`), einzige Vollfläche in Kategoriefarbe, Icon 48 in `bg`
 */
export type CategoryIconFrame = "none" | "tile" | "reveal";

export interface CategoryIconProps {
  /** Lucide-Icon-Name aus den Daten (`CategoryOption.icon`); unbekannte Namen zeigen kein Icon */
  icon: string;
  /** Kategoriefarbe aus den Daten (`#RRGGBB`), wird als CSS-Variable `--cat` gesetzt */
  color: string;
  frame?: CategoryIconFrame;
  /** Icon-Größe bei `frame="none"` (Standard 24) */
  size?: IconSize;
  /** Barrierefreier Name (Kategoriename), wenn kein Text daneben steht */
  label?: string;
}

/** Kategorie-Icon (docs/09 §2): Icon und Farbe kommen als Daten, nie hart im Code. */
export function CategoryIcon({ icon, color, frame = "none", size = 24, label }: CategoryIconProps) {
  const Icon = categoryIconFor(icon);
  const style = categoryColorStyle(color);
  const a11y = label ? ({ role: "img", "aria-label": label } as const) : ({ "aria-hidden": true } as const);

  if (frame === "tile") {
    return (
      <span
        {...a11y}
        style={style}
        className="flex size-12 shrink-0 items-center justify-center rounded-md border border-line bg-bg text-cat"
      >
        {Icon ? <Icon size={24} /> : null}
      </span>
    );
  }

  if (frame === "reveal") {
    return (
      <span
        {...a11y}
        style={style}
        className="flex size-24 shrink-0 items-center justify-center rounded-xl bg-cat text-bg"
      >
        {Icon ? <Icon size={48} /> : null}
      </span>
    );
  }

  return Icon ? <Icon {...a11y} size={size} style={style} className="shrink-0 text-cat" /> : null;
}
