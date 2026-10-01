"use client";

import { de } from "../../i18n/de";
import { OFFLINE_URL } from "../../sw/protocol";
import { Button } from "../ui/button";

/**
 * Ziel von „Erneut versuchen“: Der Service Worker zeigt die Offline-Seite unter der ursprünglich aufgerufenen
 * Adresse – dann diese neu laden. Wer `/offline` direkt aufgerufen hat, landet auf der Startseite.
 */
export function retryTarget(pathname: string): "reload" | "start" {
  return pathname === OFFLINE_URL ? "start" : "reload";
}

function retry(): void {
  if (retryTarget(window.location.pathname) === "start") window.location.assign("/");
  else window.location.reload();
}

/**
 * „Erneut versuchen“ der Offline-Seite (docs/10). Bewusst ohne automatischen Neuversuch beim `online`-Event:
 * Ein solcher Reload kann eine gerade begonnene Navigation der Person überholen und sie zurückholen.
 */
export function OfflineRetryButton() {
  return (
    <Button variant="primary" block onClick={retry} data-testid="offline-retry">
      {de.actions.retry}
    </Button>
  );
}
