"use client";

import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import { focusTitleOnViewChange } from "../../lib/ui/focus";
import { ChevronDownIcon, ChevronLeftIcon } from "../../lib/ui/icons";
import { useModalLayer } from "../../lib/ui/modal-layer";
import { MotionProvider } from "../../lib/ui/motion";
import { scrimMotion, sheetMotion } from "../../lib/ui/motion-presets";
import { Portal, useIsClient } from "../../lib/ui/portal";
import { IconButton } from "./icon-button";

export interface SheetProps {
  open: boolean;
  /** Schließen per Scrim, Escape oder `chevron-down` */
  onClose: () => void;
  /** Titel im Stil `h2` */
  title: string;
  children: ReactNode;
  /** Unteransicht: zeigt `chevron-left` „Zurück“ – der Inhalt wechselt, es öffnet sich kein zweites Sheet */
  onBack?: () => void;
  /**
   * Schlüssel der aktuellen Ansicht; wechselt er (Unteransicht), springt der Fokus auf den Titel,
   * damit Screenreader die neue Ansicht ansagen.
   */
  view?: string;
  /** Aktionsbereich unten (z. B. Button „Fertig“), mit Safe Area */
  footer?: ReactNode;
}

export interface SheetViewChange {
  previousView: string | undefined;
  view: string | undefined;
  open: boolean;
  /** neue Ansicht ist eine Unteransicht (mit „Zurück“) */
  subview: boolean;
  /** zuletzt gemessene Position der Hauptansicht */
  mainScrollTop: number;
}

/**
 * Scrollposition nach einem Ansichtswechsel im offenen Sheet – der scrollende Bereich bleibt derselbe DOM-Knoten und
 * behielte sonst die Position der vorigen Ansicht: Unteransichten beginnen oben, die Hauptansicht steht wieder dort,
 * wo man sie verlassen hat. `null` = nichts ändern (kein Wechsel, Sheet zu).
 */
export function sheetScrollTop(change: SheetViewChange): number | null {
  if (!change.open || change.previousView === change.view) return null;
  return change.subview ? 0 : change.mainScrollTop;
}

/** Was per Tab erreichbar ist (deaktivierte Bedienelemente nicht). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Tastatur (WCAG 2.1.1, axe „scrollable-region-focusable“): Scrollt der Inhalt des Sheets und enthält er kein
 * bedienbares Element – etwa die Kategorien der Nur-Lesen-Einstellungen (ADR-050), lauter statische Zeilen –, wird
 * er selbst zum Tab-Stopp; sonst ließe er sich per Tastatur nicht scrollen. Wie der Bühnen-Rahmen (overlay-frame.tsx).
 * Mit bedienbaren Elementen scrollt der Fokus den Inhalt ohnehin mit – dann kein zusätzlicher Tab-Stopp.
 */
function useKeyboardScroll(ref: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [needed, setNeeded] = useState(false);
  useEffect(() => {
    const body = ref.current;
    if (!active || !body) return;
    const check = () => setNeeded(body.scrollHeight > body.clientHeight + 1 && body.querySelector(FOCUSABLE) === null);
    // Größe des Sheets (Viewport, Tastatur) und Wechsel des Inhalts (Unteransicht, Host-Wechsel, ADR-050).
    const resize = new ResizeObserver(check);
    resize.observe(body);
    const mutations = new MutationObserver(check);
    mutations.observe(body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "tabindex", "href"],
    });
    check();
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [ref, active]);
  return active && needed;
}

/**
 * Sheet (docs/09 §5): von unten, `radius-xl` oben, Griff 36 × 4, Titel `h2`, Ebene 2 mit Scrim.
 * Modal mit Fokusfalle, Escape, `aria-modal` und Fokus-Rückgabe. Nie zwei Sheets übereinander –
 * Unteransichten wechseln den Inhalt (`onBack`, `view`).
 */
export function Sheet({ open, onClose, title, children, onBack, view, footer }: SheetProps) {
  const reduce = useReducedMotion() ?? false;
  const isClient = useIsClient();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLElement>(null);
  const bodyNeedsFocus = useKeyboardScroll(bodyRef, open && isClient);

  useModalLayer({
    active: open && isClient,
    kind: "sheet",
    containerRef: panelRef,
    initialFocusRef: titleRef,
    onEscape: onClose,
  });

  // Unteransicht gewechselt: Fokus auf den neuen Titel (der alte Fokus ist mit dem Inhalt verschwunden).
  const previousView = useRef(view);
  useEffect(() => {
    const focusTitle = focusTitleOnViewChange(previousView.current, view, open);
    previousView.current = view;
    if (focusTitle) titleRef.current?.focus({ preventScroll: true });
  }, [view, open]);

  // Scrollposition je Ansicht (vor dem Zeichnen, damit nichts springt): Unteransichten oben, Hauptansicht wie verlassen.
  const subview = onBack !== undefined;
  const mainScrollTop = useRef(0);
  const scrolledView = useRef(view);
  useLayoutEffect(() => {
    const target = sheetScrollTop({
      previousView: scrolledView.current,
      view,
      open,
      subview,
      mainScrollTop: mainScrollTop.current,
    });
    scrolledView.current = view;
    if (!open) mainScrollTop.current = 0;
    if (target !== null && bodyRef.current) bodyRef.current.scrollTop = target;
  }, [view, open, subview]);

  const motionProps = sheetMotion(reduce);

  return (
    <Portal>
      <MotionProvider>
        <AnimatePresence>
          {open ? (
            <div key="sheet" className="fixed inset-0 z-sheet flex flex-col justify-end">
              <m.div {...scrimMotion} aria-hidden="true" className="absolute inset-0 bg-scrim" onClick={onClose} />
              <m.div
                {...motionProps}
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className="relative mx-auto flex max-h-sheet w-full max-w-column flex-col rounded-t-xl border border-b-0 border-line bg-surface-1 shadow-level-2"
              >
                <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong" />
                <div className="flex shrink-0 items-center gap-2 px-gutter pt-2 pb-3">
                  {onBack ? <IconButton icon={ChevronLeftIcon} label={de.actions.back} onClick={onBack} /> : null}
                  <h2
                    ref={titleRef}
                    id={titleId}
                    tabIndex={-1}
                    className="min-w-0 flex-1 text-h2 text-text wrap-break-word"
                  >
                    {title}
                  </h2>
                  <IconButton icon={ChevronDownIcon} label={de.actions.close} onClick={onClose} />
                </div>
                <section
                  ref={bodyRef}
                  // Nur solange er scrollt und nichts Bedienbares enthält: Tab-Stopp zum Scrollen (WCAG 2.1.1), dann
                  // mit Namen ein Bereich (`region`) – sonst ein schlichter Abschnitt ohne Rolle.
                  tabIndex={bodyNeedsFocus ? 0 : undefined}
                  aria-label={bodyNeedsFocus ? title : undefined}
                  onScroll={
                    subview
                      ? undefined
                      : (event) => {
                          mainScrollTop.current = event.currentTarget.scrollTop;
                        }
                  }
                  data-testid="sheet-body"
                  className={cx(
                    "min-h-0 flex-1 overflow-y-auto overscroll-contain px-gutter",
                    footer ? "pb-4" : "pb-safe",
                  )}
                >
                  {children}
                </section>
                {footer ? <div className="shrink-0 border-t border-line px-gutter pt-4 pb-safe">{footer}</div> : null}
              </m.div>
            </div>
          ) : null}
        </AnimatePresence>
      </MotionProvider>
    </Portal>
  );
}
