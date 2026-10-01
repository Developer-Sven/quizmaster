"use client";

import { statusBannerKind, useUpdateAvailable } from "@/components/pwa/service-worker";
import { UpdateBanner } from "@/components/pwa/update-banner";
import { Banner } from "@/components/ui/banner";
import { selectMaintenance, selectPhase, selectUpdateRequired, useGameStore } from "@/stores/game-store";

/**
 * Banner unter der Kopfzeile (docs/09 §5): „Neue Version verfügbar“ + „Aktualisieren“ bei `UPDATE_REQUIRED`
 * oder wartendem Service Worker (docs/10 – nur in Lobby und ab `game_over`, nie im laufenden Spiel),
 * Wartungshinweis nach `notice: MAINTENANCE`. Höchstens eines – Update hat Vorrang.
 */
export function StatusBanners() {
  const updateRequired = useGameStore(selectUpdateRequired);
  const maintenance = useGameStore(selectMaintenance);
  const phase = useGameStore(selectPhase);
  const updateWaiting = useUpdateAvailable();
  const kind = statusBannerKind({ updateRequired, updateWaiting, maintenance, phase });
  if (kind === "update") return <UpdateBanner required />;
  if (kind === "maintenance") return <Banner tone="maintenance" />;
  return null;
}
