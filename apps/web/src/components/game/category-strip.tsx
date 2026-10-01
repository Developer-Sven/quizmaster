import { CategoryIcon } from "@/components/ui/category-icon";
import { type CategoryVisual, categoryColorStyle } from "@/lib/ui/category";

export interface CategoryStripProps {
  /** Kategorie des laufenden Zuges; `null` vor der Wahl (Höhe bleibt, keine Layout-Sprünge) */
  category: CategoryVisual | null;
  /** „1/3“ (Frage x/K) oder `null` */
  fraction: string | null;
}

/**
 * Kategoriestreifen (docs/09 §7): 44 px unter dem HUD, 4-px-Farbstreifen links (einer der drei Orte für
 * Kategoriefarben), Icon + Name, rechts Frage x/K.
 */
export function CategoryStrip({ category, fraction }: CategoryStripProps) {
  return (
    <div data-testid="category-strip" className="border-b border-line bg-surface-1">
      <div className="relative mx-auto flex h-11 w-full max-w-column items-center gap-3 px-gutter">
        {category ? (
          <>
            <span
              aria-hidden="true"
              style={categoryColorStyle(category.color)}
              className="absolute inset-y-0 left-0 w-1 bg-cat"
            />
            <CategoryIcon icon={category.icon} color={category.color} size={20} />
            <span className="min-w-0 flex-1 truncate text-label text-text">{category.name}</span>
            {fraction ? <span className="shrink-0 text-label text-text-2 tabular-nums">{fraction}</span> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
