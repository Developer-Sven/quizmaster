import type { CategoryVisual } from "../../lib/ui/category";
import { CategoryIcon } from "./category-icon";

export interface CategoryBadgeProps {
  category: CategoryVisual;
  /** nur das Icon (Tafel, „Fragen ansehen“); der Name wird Screenreader-Text und Tooltip */
  compact?: boolean;
}

/** CategoryBadge (docs/09 §5): Chip 32 hoch, `surface-2`, `radius-md`, Icon 16 in Kategoriefarbe + Name (`label`). */
export function CategoryBadge({ category, compact = false }: CategoryBadgeProps) {
  if (compact) {
    return (
      <span
        role="img"
        aria-label={category.name}
        title={category.name}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2"
      >
        <CategoryIcon icon={category.icon} color={category.color} size={16} />
      </span>
    );
  }
  return (
    <span className="inline-flex h-8 max-w-full items-center gap-2 rounded-md bg-surface-2 px-3 text-label text-text">
      <CategoryIcon icon={category.icon} color={category.color} size={16} />
      <span className="truncate">{category.name}</span>
    </span>
  );
}
