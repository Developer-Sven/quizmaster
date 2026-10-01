"use client";

import type { ErrorCode } from "@quizmaster/shared";
import { ErrorView } from "@/components/app/error-view";
import { Button } from "@/components/ui/button";
import { de, kickedMessage } from "@/i18n/de";
import { errorText } from "@/lib/client/errors";
import { reloadPage } from "@/lib/client/reload";
import { type LucideIcon, RefreshCwIcon, TriangleAlertIcon, UserRoundXIcon, UsersIcon } from "@/lib/ui/icons";
import type { LobbyExit } from "@/stores/game-store";

function exitIcon(code: ErrorCode): LucideIcon {
  if (code === "LOBBY_FULL") return UsersIcon;
  if (code === "KICKED") return UserRoundXIcon;
  return TriangleAlertIcon;
}

/**
 * Die Lobby ist für diese Person vorbei (docs/05 §Reconnect: Startseite mit Hinweis; docs/09 §6
 * Fehlerseiten): Lobby nicht gefunden, voll, läuft bereits, entfernt, aufgegeben – je `EmptyState` +
 * „Zur Startseite“.
 */
export function LobbyExitView({ exit }: { exit: LobbyExit }) {
  if (exit.kind === "kicked") {
    return <ErrorView testId="lobby-exit" icon={UserRoundXIcon} message={kickedMessage(exit.reason)} />;
  }
  return <ErrorView testId="lobby-exit" icon={exitIcon(exit.code)} message={errorText(exit.code)} />;
}

/**
 * Endgültiger Verbindungsfehler (Sitzung abgelaufen, gesperrt, veraltete Version): Hinweis und Neuladen
 * („Aktualisieren“ bei UPDATE_REQUIRED, sonst „Erneut versuchen“).
 */
export function LobbyFatalView({ code }: { code: ErrorCode }) {
  return (
    <ErrorView
      testId="lobby-fatal"
      icon={code === "UPDATE_REQUIRED" ? RefreshCwIcon : TriangleAlertIcon}
      message={errorText(code)}
      action={
        <Button variant="primary" block onClick={reloadPage}>
          {code === "UPDATE_REQUIRED" ? de.actions.update : de.actions.retry}
        </Button>
      }
    />
  );
}
