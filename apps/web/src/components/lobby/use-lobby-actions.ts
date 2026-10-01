"use client";

import { de } from "@/i18n/de";
import { actionErrorPlacement, type ClientErrorCode, errorText } from "@/lib/client/errors";
import { getRealtimeClient, type RealtimeClient } from "@/lib/client/realtime-client";
import { copyText, shareOrCopy } from "@/lib/client/share";
import { clientTexts } from "@/lib/client/texts";
import { gameActions } from "@/stores/game-store";

export interface LobbyActions {
  /** Realtime-Client dieser Seite (erst bei Bedarf erzeugt, nie im Render auf dem Server) */
  client: () => RealtimeClient;
  /**
   * Fehler einer Aktion anzeigen: Fälle, die die Oberfläche verhindert, still per `lobby:resume`
   * korrigieren; `UPDATE_REQUIRED` zeigt der Banner; alles andere als Fehler-Toast.
   */
  fail: (code: ClientErrorCode) => void;
  copyCode: (code: string) => Promise<void>;
  shareInvite: (displayCode: string, url: string) => Promise<void>;
}

/** Gemeinsame Aktionen der Lobby- und Spielseite. */
export function useLobbyActions(realtimeUrl: string): LobbyActions {
  const client = () => getRealtimeClient({ realtimeUrl });

  const fail = (code: ClientErrorCode) => {
    const placement = actionErrorPlacement(code);
    if (placement === "resync") client().resync();
    else if (placement !== "banner") gameActions.showToast("error", errorText(code));
  };

  const copyCode = async (code: string) => {
    const copied = await copyText(code);
    if (copied) gameActions.showToast("info", clientTexts.lobby.codeCopied);
    else gameActions.showToast("error", clientTexts.lobby.copyFailed);
  };

  const shareInvite = async (displayCode: string, url: string) => {
    const outcome = await shareOrCopy({ title: de.app.name, text: clientTexts.lobby.inviteText(displayCode), url });
    if (outcome === "copied") gameActions.showToast("info", clientTexts.lobby.linkCopied);
    else if (outcome === "failed") gameActions.showToast("error", clientTexts.lobby.copyFailed);
  };

  return { client, fail, copyCode, shareInvite };
}
