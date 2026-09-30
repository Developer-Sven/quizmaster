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
 * Toast (docs/09 §5): unten über der Aktionsleiste, eine Zeile, Icon 20, 3 s; info oder Fehler.
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

  const Icon = icon ?? (tone === "error" ? TriangleAlertIcon : CheckIcon);
  const visual = message ? (
    <m.div
      key={message}
      {...panelMotion(reduce)}
      aria-hidden="true"
      className="flex w-full max-w-column items-center gap-3 rounded-lg border border-line-strong bg-surface-2 px-4 py-3"
    >
      <Icon size={20} className={cx("shrink-0", tone === "error" ? "text-danger" : "text-text-2")} />
      <span className="min-w-0 flex-1 truncate text-body text-text">{message}</span>
    </m.div>
  ) : null;

  return (
    <Portal>
      <div className="pointer-events-none fixed inset-x-0 bottom-toast z-toast flex justify-center px-gutter">
        <MotionProvider>
          <AnimatePresence mode="wait">{visual}</AnimatePresence>
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
