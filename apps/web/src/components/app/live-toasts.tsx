"use client";

import { Toast } from "@/components/ui/toast";
import { CrownIcon, LogOutIcon, type LucideIcon, RefreshCwIcon, Settings2Icon } from "@/lib/ui/icons";
import { gameActions, selectCurrentToast, type ToastKind, useGameStore } from "@/stores/game-store";

/**
 * Icons der Hinweise (docs/09 §7.10, nur Icons aus §9): Host gewechselt und „Der Host hat das Spiel beendet.“
 * `crown` (Host, ADR-051), aufgegeben `log-out`, Neustart `refresh-cw`, Vorschläge `settings-2` (wie der Abschnitt
 * „Vorschläge“ in der Lobby, ADR-053). Eigene Bestätigungen und Fehler nutzen das Standard-Icon des Toasts.
 */
const TOAST_ICONS: Partial<Record<ToastKind, LucideIcon>> = {
  hostChanged: CrownIcon,
  playerResigned: LogOutIcon,
  serverRestart: RefreshCwIcon,
  suggestion: Settings2Icon,
  gameEnded: CrownIcon,
};

/** Icon eines Hinweises; `undefined` = Standard des Toasts (info `check`, Fehler `triangle-alert`). */
export function toastIcon(kind: ToastKind): LucideIcon | undefined {
  return TOAST_ICONS[kind];
}

/** Zeigt die Hinweise aus dem Store nacheinander als Toast (3 s, unten über der Aktionsleiste). */
export function LiveToasts() {
  const toast = useGameStore(selectCurrentToast);
  return (
    <Toast
      message={toast?.text ?? null}
      tone={toast?.kind === "error" ? "error" : "info"}
      icon={toast ? toastIcon(toast.kind) : undefined}
      onDismiss={() => {
        if (toast) gameActions.dismissToast(toast.id);
      }}
    />
  );
}
