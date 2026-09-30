/** Selektor für per Tastatur erreichbare Elemente (ohne `tabindex="-1"`). */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

/** Sichtbare, fokussierbare Elemente innerhalb von `root` in Dokumentreihenfolge. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.closest("[inert]") && element.getClientRects().length > 0,
  );
}

/**
 * Nächster Index der Fokusfalle: Tab vom letzten Element springt zum ersten, Umschalt+Tab vom
 * ersten zum letzten. `current = -1` (Fokus nicht in der Liste) startet am Rand.
 */
export function nextTrapIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  if (backwards) return current === 0 ? count - 1 : current - 1;
  return current === count - 1 ? 0 : current + 1;
}

/** Hält Tab/Umschalt+Tab innerhalb von `container` (Fokusfalle für Sheet und Dialog). */
export function trapTabKey(event: KeyboardEvent, container: HTMLElement): void {
  const items = focusableWithin(container);
  event.preventDefault();
  if (items.length === 0) {
    container.focus({ preventScroll: true });
    return;
  }
  const active = document.activeElement;
  const current = active instanceof HTMLElement ? items.indexOf(active) : -1;
  items[nextTrapIndex(current, items.length, event.shiftKey)]?.focus({ preventScroll: true });
}
