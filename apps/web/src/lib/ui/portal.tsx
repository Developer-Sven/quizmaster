"use client";

import { type ReactNode, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

const noopSubscribe = () => () => {};

/** true erst im Browser (nach der Hydration), auf dem Server false – ohne Hydration-Warnung. */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/** Rendert Ebenen (Sheet, Dialog, Toast) direkt in `document.body`, damit kein Eltern-Overflow sie abschneidet. */
export function Portal({ children }: { children: ReactNode }) {
  return useIsClient() ? createPortal(children, document.body) : null;
}
