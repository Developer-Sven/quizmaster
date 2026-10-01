"use client";

import { Toast } from "@/components/ui/toast";
import { CrownIcon, LogOutIcon, type LucideIcon, RefreshCwIcon } from "@/lib/ui/icons";
import { gameActions, selectCurrentToast, type ToastKind, useGameStore } from "@/stores/game-store";

/** Icons der Hinweise (docs/09 §7.10): Host gewechselt `crown`, aufgegeben `log-out`. */
const TOAST_ICONS: Partial<Record<ToastKind, LucideIcon>> = {
  hostChanged: CrownIcon,
  playerResigned: LogOutIcon,
  serverRestart: RefreshCwIcon,
};

/** Zeigt die Hinweise aus dem Store nacheinander als Toast (3 s, unten über der Aktionsleiste). */
export function LiveToasts() {
  const toast = useGameStore(selectCurrentToast);
  return (
    <Toast
      message={toast?.text ?? null}
      tone={toast?.kind === "error" ? "error" : "info"}
      icon={toast ? TOAST_ICONS[toast.kind] : undefined}
      onDismiss={() => {
        if (toast) gameActions.dismissToast(toast.id);
      }}
    />
  );
}
