"use client";

import { createContext, useContext } from "react";
import { statusBannerKind, useUpdateAvailable } from "@/components/pwa/service-worker";
import { UpdateBanner } from "@/components/pwa/update-banner";
import { Banner } from "@/components/ui/banner";
import { de } from "@/i18n/de";
import type { MaintenanceNotice } from "@/lib/server/maintenance";
import { selectMaintenance, selectPhase, selectUpdateRequired, useGameStore } from "@/stores/game-store";

/**
 * Serverseitig ermittelter Wartungshinweis der Seite (`getMaintenanceNotice`: appConfig.maintenance oder Datenbank
 * nicht erreichbar) – als Prop von der Seite, im Lobby-Bildschirm als Kontext bereitgestellt.
 */
export const MaintenanceNoticeContext = createContext<MaintenanceNotice | null>(null);

/**
 * Banner unter der Kopfzeile (docs/09 §5): „Neue Version verfügbar“ + „Aktualisieren“ bei `UPDATE_REQUIRED`
 * oder wartendem Service Worker (docs/10 – nur in Lobby und ab `game_over`, nie im laufenden Spiel),
 * sonst Wartung (docs/09 §11: Text aus `appConfig.maintenance.message`, sonst „Wartung – gleich geht es weiter.“).
 * Höchstens eines – Update hat Vorrang.
 *
 * Wartung gilt nach `notice: MAINTENANCE` des Realtime-Servers (er sendet den Hinweis auch direkt nach jedem
 * Verbinden, solange die Wartung läuft) und – solange keine Verbindung besteht – nach dem Hinweis vom Seitenaufruf
 * (z. B. Datenbank nicht erreichbar, docs/12 Runbook). Verbunden entscheidet der Realtime-Server.
 */
export function StatusBanners() {
  const updateRequired = useGameStore(selectUpdateRequired);
  const notified = useGameStore(selectMaintenance);
  const connected = useGameStore((state) => state.connection.status === "connected");
  const phase = useGameStore(selectPhase);
  const updateWaiting = useUpdateAvailable();
  const serverNotice = useContext(MaintenanceNoticeContext);
  const maintenance = notified || (serverNotice !== null && !connected);
  const kind = statusBannerKind({ updateRequired, updateWaiting, maintenance, phase });
  if (kind === "update") return <UpdateBanner required />;
  if (kind === "maintenance") {
    return (
      <div data-testid="maintenance-banner">
        <Banner tone="maintenance" message={de.maintenance.message(serverNotice?.message)} />
      </div>
    );
  }
  return null;
}
