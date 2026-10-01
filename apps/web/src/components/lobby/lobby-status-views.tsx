"use client";

import type { ErrorCode } from "@quizmaster/shared";
import { useEffect, useRef } from "react";
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
 * Diese Ansichten ersetzen die Lobby bzw. das Spiel, während die Seite offen ist: Die Überschrift bekommt den
 * Fokus (sonst fiele er mit dem verschwundenen Inhalt auf `body`, und Screenreader sagten nichts an – WCAG 2.4.3,
 * 4.1.3), der Seitentitel nennt den Grund statt weiter „Lobby“ (WCAG 2.4.2). Verschwindet die Ansicht wieder
 * (z. B. der Zustand kommt doch noch), gilt der vorige Titel.
 */
function useAnnouncedView(message: string) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    const previous = document.title;
    document.title = de.app.pageTitle(message);
    return () => {
      document.title = previous;
    };
  }, [message]);
  return headingRef;
}

/**
 * Die Lobby ist für diese Person vorbei (docs/05 §Reconnect: Startseite mit Hinweis; docs/09 §6
 * Fehlerseiten): Lobby nicht gefunden, voll, läuft bereits, entfernt, aufgegeben – je `EmptyState` +
 * „Zur Startseite“.
 */
export function LobbyExitView({ exit }: { exit: LobbyExit }) {
  const message = exit.kind === "kicked" ? kickedMessage(exit.reason) : errorText(exit.code);
  const headingRef = useAnnouncedView(message);
  const icon = exit.kind === "kicked" ? UserRoundXIcon : exitIcon(exit.code);
  return <ErrorView testId="lobby-exit" icon={icon} message={message} headingRef={headingRef} />;
}

/**
 * Verbunden, aber auch nach längerer Zeit kein Lobby-Zustand (z. B. `lobby:resume` scheitert dauerhaft):
 * allgemeiner Hinweis und „Erneut versuchen“ (Neuladen) statt eines endlosen Skeletons (docs/09 Regel 11).
 */
export function LobbyStalledView() {
  const message = errorText("INTERNAL");
  const headingRef = useAnnouncedView(message);
  return (
    <ErrorView
      testId="lobby-stalled"
      message={message}
      headingRef={headingRef}
      action={
        <Button variant="primary" block onClick={reloadPage}>
          {de.actions.retry}
        </Button>
      }
    />
  );
}

/**
 * Endgültiger Verbindungsfehler (Sitzung abgelaufen, gesperrt, veraltete Version): Hinweis und Neuladen
 * („Aktualisieren“ bei UPDATE_REQUIRED, sonst „Erneut versuchen“).
 */
export function LobbyFatalView({ code }: { code: ErrorCode }) {
  const message = errorText(code);
  const headingRef = useAnnouncedView(message);
  return (
    <ErrorView
      testId="lobby-fatal"
      icon={code === "UPDATE_REQUIRED" ? RefreshCwIcon : TriangleAlertIcon}
      message={message}
      headingRef={headingRef}
      action={
        <Button variant="primary" block onClick={reloadPage}>
          {code === "UPDATE_REQUIRED" ? de.actions.update : de.actions.retry}
        </Button>
      }
    />
  );
}
