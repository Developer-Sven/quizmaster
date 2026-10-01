/**
 * Zulassung neuer Lobbys (docs/06 §DDoS-Schichten 5–6, §Rate-Limits „Globale Kontingente“): Reihenfolge der
 * Prüfungen und Fehlercodes
 *
 * 1. Shutdown läuft → `SERVER_BUSY` (keine neuen Lobbys während des Herunterfahrens),
 * 2. Kill-Switch `appConfig.lobbyCreationEnabled = false` → `LOBBY_CREATION_DISABLED`,
 * 3. Lastabwurf: Event-Loop-Verzögerung p99 > 200 ms (zwei Fenster in Folge) → `SERVER_BUSY`,
 * 4. Lastabwurf: Verbindungszahl an der globalen Grenze `MAX_CONNECTIONS` → `SERVER_BUSY` (wer jetzt eine Lobby
 *    anlegt, bringt Mitspielende mit, deren Verbindungen ohnehin abgelehnt würden),
 * 5. Kontingent `appConfig.maxActiveLobbies` erreicht → `SERVER_BUSY`.
 *
 * Laufende Spiele berührt nichts davon (docs/06: „laufende Spiele laufen weiter“). Alle Werte werden bei jedem
 * Aufruf live gelesen – Änderungen per Change Stream (`watchers/app-config.ts`) wirken sofort.
 */
import type { ErrorCode } from "@quizmaster/shared";
import type { RealtimeMetrics } from "../metrics.ts";
import type { AdmissionService, Lifecycle } from "../registry/types.ts";
import type { AppConfigService } from "./app-config.ts";
import type { ConnectionsService } from "./connections.ts";

export interface AdmissionDeps {
  lifecycle: Lifecycle;
  appConfig: Pick<AppConfigService, "get">;
  metrics: { readonly eventLoop: Pick<RealtimeMetrics["eventLoop"], "overloaded"> };
  connections: Pick<ConnectionsService, "total" | "limits">;
}

export function createAdmissionService(deps: AdmissionDeps): AdmissionService {
  return {
    lobbyCreation(activeLobbies): ErrorCode | null {
      if (deps.lifecycle.isShuttingDown()) return "SERVER_BUSY";
      const config = deps.appConfig.get();
      if (!config.lobbyCreationEnabled) return "LOBBY_CREATION_DISABLED";
      if (deps.metrics.eventLoop.overloaded()) return "SERVER_BUSY";
      if (deps.connections.total() >= deps.connections.limits.global) return "SERVER_BUSY";
      if (activeLobbies >= config.maxActiveLobbies) return "SERVER_BUSY";
      return null;
    },
  };
}
