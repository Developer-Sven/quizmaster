"use client";

import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useEffectEvent } from "react";
import { cx } from "../../lib/ui/cx";
import { CheckIcon, type LucideIcon, TriangleAlertIcon } from "../../lib/ui/icons";
import { MotionProvider } from "../../lib/ui/motion";
import { panelMotion } from "../../lib/ui/motion-presets";
import { Portal } from "../../lib/ui/portal";
import { TOAST_DURATION_MS } from "../../lib/ui/tokens";

export type ToastTone = "info" | "error";

export interface ToastProps {
  /** Text der aktuellen Meldung; `null` = keine Meldung */
  message: string | null;
  tone?: ToastTone;
  /** Icon 20 (z. B. `crown` Host gewechselt, `log-out` aufgegeben); Standard: info `check`, Fehler `triangle-alert` */
  icon?: LucideIcon;
  /** nach 3 s aufgerufen – hier die Meldung auf `null` setzen */
  onDismiss: () => void;
  durationMs?: number;
}

/**
 * Toast (docs/09 §5): unten über der Aktionsleiste, Icon 20, 3 s; info oder Fehler.
 * Die Live-Regionen bleiben dauerhaft im DOM, damit Screenreader neue Meldungen sicher ansagen –
 * die Komponente deshalb immer rendern und nur `message` wechseln.
 */
export function Toast({ message, tone = "info", icon, onDismiss, durationMs = TOAST_DURATION_MS }: ToastProps) {
  const reduce = useReducedMotion() ?? false;
  const dismiss = useEffectEvent(() => onDismiss());

  useEffect(() => {
    if (message === null) return;
    const timeout = window.setTimeout(dismiss, durationMs);
    return () => window.clearTimeout(timeout);
  }, [message, durationMs]);

  return (
    <Portal>
      <div className="pointer-events-none fixed inset-x-0 bottom-toast z-toast flex justify-center px-gutter">
        <MotionProvider>
          <AnimatePresence mode="wait">
            {message ? <ToastPanel key={message} message={message} tone={tone} icon={icon} reduce={reduce} /> : null}
          </AnimatePresence>
        </MotionProvider>
        <span className="sr-only" role="status">
          {tone === "info" ? message : null}
        </span>
        <span className="sr-only" role="alert">
          {tone === "error" ? message : null}
        </span>
      </div>
    </Portal>
  );
}

export interface ToastPanelProps {
  message: string;
  tone: ToastTone;
  icon?: LucideIcon | undefined;
  reduce?: boolean;
}

/**
 * Sichtbarer Teil des Toasts: schwebendes Panel der Ebene 2 (`surface-1`, 1 px `line`, `radius-xl`,
 * Schatten – docs/09 §2), damit er sich über Sheets nicht wie eine Listenzeile oder ein Button liest.
 * Lange Meldungen (docs/09 §11, bis ~50 Zeichen) brechen um statt abgeschnitten zu werden – bei 360 px
 * zwei Zeilen. Für Screenreader verborgen: Ansagen kommen aus den Live-Regionen von {@link Toast}.
 */
export function ToastPanel({ message, tone, icon, reduce = false }: ToastPanelProps) {
  const Icon = icon ?? (tone === "error" ? TriangleAlertIcon : CheckIcon);
  return (
    <m.div
      {...panelMotion(reduce)}
      aria-hidden="true"
      className="flex w-full max-w-column items-center gap-3 rounded-xl border border-line bg-surface-1 px-4 py-3 shadow-level-2"
    >
      <Icon size={20} className={cx("shrink-0", tone === "error" ? "text-danger" : "text-text-2")} />
      <span className="min-w-0 flex-1 text-body text-text">{message}</span>
    </m.div>
  );
}
