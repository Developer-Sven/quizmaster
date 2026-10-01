"use client";

import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useId, useRef } from "react";
import { useModalLayer } from "../../lib/ui/modal-layer";
import { MotionProvider } from "../../lib/ui/motion";
import { panelMotion, scrimMotion } from "../../lib/ui/motion-presets";
import { Portal, useIsClient } from "../../lib/ui/portal";
import { Button } from "./button";

export interface DialogProps {
  open: boolean;
  /** Titel im Stil `h2`, z. B. „Spiel verlassen?“ */
  title: string;
  /** höchstens 2 Zeilen, z. B. „Du giltst dann als aufgegeben.“ */
  description?: string;
  /** bestätigende Aktion, z. B. „Verlassen“ */
  confirmLabel: string;
  /** sichere Aktion, z. B. „Weiterspielen“; bekommt beim Öffnen den Fokus */
  cancelLabel: string;
  onConfirm: () => void;
  /** auch bei Escape und Tippen auf den Scrim */
  onCancel: () => void;
  /** Stil der Bestätigung: `destructive` (Text rot, Standard) oder `primary` */
  confirmVariant?: "destructive" | "primary";
  /** Bestätigung läuft (Button zeigt `loader-circle`) */
  confirming?: boolean;
}

/**
 * Dialog (docs/09 §5): zentriert, max. 360, Titel `h2`, max. 2 Zeilen Text, 2 Buttons – nur für
 * Bestätigungen. `alertdialog` mit Fokusfalle, Escape = Abbrechen, Fokus-Rückgabe; liegt über Sheets.
 * Die 2 Zeilen gelten für die Texte bei 100 %: Bei Text-Zoom bricht alles um statt abgeschnitten zu werden, und
 * ist der Dialog dann höher als der Bildschirm, scrollt er (WCAG 1.4.4, 1.4.10).
 */
export function Dialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  confirmVariant = "destructive",
  confirming = false,
}: DialogProps) {
  const reduce = useReducedMotion() ?? false;
  const isClient = useIsClient();
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useModalLayer({
    active: open && isClient,
    kind: "dialog",
    containerRef: panelRef,
    initialFocusRef: cancelRef,
    onEscape: onCancel,
  });

  return (
    <Portal>
      <MotionProvider>
        <AnimatePresence>
          {open ? (
            <div
              key="dialog"
              className="fixed inset-0 z-overlay flex items-center-safe justify-center overflow-y-auto overscroll-contain px-gutter py-6"
            >
              <m.div {...scrimMotion} aria-hidden="true" className="fixed inset-0 bg-scrim" onClick={onCancel} />
              <m.div
                {...panelMotion(reduce)}
                ref={panelRef}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={description ? descriptionId : undefined}
                tabIndex={-1}
                className="relative w-full max-w-dialog rounded-xl border border-line bg-surface-1 p-6 shadow-level-2"
              >
                <h2 id={titleId} className="text-h2 text-text wrap-break-word">
                  {title}
                </h2>
                {description ? (
                  <p id={descriptionId} className="mt-2 text-body text-text-2 wrap-break-word">
                    {description}
                  </p>
                ) : null}
                <div className="mt-6 flex flex-col gap-3">
                  <Button variant={confirmVariant} block loading={confirming} onClick={onConfirm}>
                    {confirmLabel}
                  </Button>
                  <Button ref={cancelRef} variant="secondary" block onClick={onCancel}>
                    {cancelLabel}
                  </Button>
                </div>
              </m.div>
            </div>
          ) : null}
        </AnimatePresence>
      </MotionProvider>
    </Portal>
  );
}
