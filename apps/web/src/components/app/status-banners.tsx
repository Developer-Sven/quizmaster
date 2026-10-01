"use client";

import { Banner } from "@/components/ui/banner";
import { reloadPage } from "@/lib/client/reload";
import { selectMaintenance, selectUpdateRequired, useGameStore } from "@/stores/game-store";

/**
 * Banner unter der Kopfzeile (docs/09 §5): „Neue Version verfügbar“ + „Aktualisieren“ bei
 * `UPDATE_REQUIRED`, Wartungshinweis nach `notice: MAINTENANCE`. Höchstens eines – Update hat Vorrang.
 */
export function StatusBanners() {
  const updateRequired = useGameStore(selectUpdateRequired);
  const maintenance = useGameStore(selectMaintenance);
  if (updateRequired) return <Banner tone="update" onAction={reloadPage} />;
  if (maintenance) return <Banner tone="maintenance" />;
  return null;
}
