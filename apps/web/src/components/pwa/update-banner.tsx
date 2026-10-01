"use client";

import { Banner } from "../ui/banner";
import { applyUpdate, useUpdateAvailable } from "./service-worker";

export interface UpdateBannerProps {
  /** Der Server verlangt ein Update (`UPDATE_REQUIRED`): Banner auch ohne wartenden Service Worker zeigen. */
  required?: boolean;
}

/**
 * „Neue Version verfügbar“ + „Aktualisieren“ (`refresh-cw`-Fluss aus docs/10, Banner docs/09 §5): erscheint,
 * sobald ein neuer Service Worker wartet. Tippen sendet SKIP_WAITING und lädt nach `controllerchange` neu.
 * Nur auf Start- und Lobby-Screen sowie ab `game_over` einsetzen – im Spiel entscheidet `StatusBanners`.
 */
export function UpdateBanner({ required = false }: UpdateBannerProps) {
  const available = useUpdateAvailable();
  if (!required && !available) return null;
  return (
    <div data-testid="update-banner">
      <Banner tone="update" onAction={applyUpdate} />
    </div>
  );
}
