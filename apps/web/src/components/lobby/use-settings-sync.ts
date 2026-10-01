"use client";

import { DEFAULT_LOBBY_SETTINGS, type LobbySettings, type SettingsUpdate } from "@quizmaster/shared";
import { useEffect, useState } from "react";
import type { ClientErrorCode } from "@/lib/client/errors";
import type { EmitResult } from "@/lib/client/realtime-client";
import { SettingsSync } from "@/lib/client/settings-sync";

export interface SettingsSyncView {
  /** Server-Stand samt noch nicht bestätigter Tipps (`null` ohne Lobby) */
  shown: LobbySettings | null;
  change: (update: SettingsUpdate) => void;
  /** Offene Tipps sofort senden und abwarten (Sheet zu, „Spiel starten“) */
  flush: () => Promise<void>;
}

/**
 * Stepper-Tipps des Hosts gebündelt senden (ADR-042, {@link SettingsSync}): sofort anzeigen, nach kurzer Pause
 * nur den neuesten Stand senden, bei RATE_LIMITED still wiederholen.
 */
export function useSettingsSync(
  settings: LobbySettings | null,
  send: (update: SettingsUpdate) => Promise<EmitResult<null>>,
  onRejected: (code: ClientErrorCode) => void,
): SettingsSyncView {
  const [draft, setDraft] = useState<Partial<LobbySettings>>({});
  const [sync] = useState(
    () => new SettingsSync(settings ?? DEFAULT_LOBBY_SETTINGS, { send, onDraft: setDraft, onRejected }),
  );

  useEffect(() => {
    sync.setDeps({ send, onDraft: setDraft, onRejected });
  }, [sync, send, onRejected]);

  useEffect(() => {
    if (settings !== null) sync.serverChanged(settings);
  }, [sync, settings]);

  useEffect(() => {
    sync.start();
    return () => sync.dispose();
  }, [sync]);

  return {
    shown: settings === null ? null : { ...settings, ...draft },
    change: (update) => sync.change(update),
    flush: () => sync.flush(),
  };
}
