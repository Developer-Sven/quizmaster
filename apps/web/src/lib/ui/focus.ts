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

/**
 * Wohin die Fokusfalle den Fokus selbst setzt – `null` = der Browser übernimmt (normales Tab innerhalb der
 * Ebene). Eingegriffen wird nur am Rand (vom letzten Element vorwärts, vom ersten rückwärts) und wenn der
 * Fokus außerhalb der Liste steht (z. B. auf dem Titel): Nur so scrollt der Browser jedes Ziel in den
 * sichtbaren Bereich des Sheets und berücksichtigt `scroll-padding` (WCAG 2.4.7, 2.4.11).
 */
export function trapRedirectIndex(current: number, count: number, backwards: boolean): number | null {
  if (count <= 0) return -1;
  const atEdge = current < 0 || (backwards ? current === 0 : current === count - 1);
  return atEdge ? nextTrapIndex(current, count, backwards) : null;
}

/**
 * Ob ein Ansichtswechsel den Fokus auf den Titel der Ebene setzt (Sheet-Unteransichten), damit
 * Screenreader die neue Ansicht ansagen. Nur solange die Ebene offen ist: Setzen die Eltern `view`
 * beim Schließen zurück, hat `useModalLayer` den Fokus bereits an den Auslöser zurückgegeben – ihn
 * auf den Titel des ausblendenden Panels zu ziehen, ließe ihn nach der Exit-Animation auf `<body>`
 * fallen (WCAG 2.4.3).
 */
export function focusTitleOnViewChange(
  previousView: string | undefined,
  view: string | undefined,
  open: boolean,
): boolean {
  return open && previousView !== view;
}

/**
 * Hält Tab/Umschalt+Tab innerhalb von `container` (Fokusfalle für Sheet und Dialog). Innerhalb der Ebene
 * tabbt der Browser selbst und scrollt dabei das Ziel in den sichtbaren Bereich; nur am Rand springt der
 * Fokus herum – auch dann ohne `preventScroll`, damit z. B. die letzte Frage in „Fragen ansehen“ sichtbar wird.
 */
export function trapTabKey(event: KeyboardEvent, container: HTMLElement): void {
  const items = focusableWithin(container);
  if (items.length === 0) {
    event.preventDefault();
    container.focus({ preventScroll: true });
    return;
  }
  const active = document.activeElement;
  const current = active instanceof HTMLElement ? items.indexOf(active) : -1;
  const target = trapRedirectIndex(current, items.length, event.shiftKey);
  if (target === null) return;
  event.preventDefault();
  items[target]?.focus();
}
