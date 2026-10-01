"use client";

import { de } from "../../i18n/de";
import { SmartphoneIcon } from "../../lib/ui/icons";
import { ListRow } from "../ui/list-row";
import { promptInstall, useInstallMethod } from "./install-state";

/**
 * Zeile „Als App installieren“ (`smartphone`) über dem Footer der Startseite (docs/09 §6, ADR-040): nur wo der
 * Browser direkt installieren kann (Chromium mit `beforeinstallprompt`) und die App noch nicht installiert ist –
 * ein Tipp öffnet sofort den Installationsdialog des Browsers. Kein Pop-up, keine Anleitung.
 */
export function InstallRow() {
  const method = useInstallMethod();
  if (method === null) return null;
  return (
    <div data-testid="install-row" data-method={method}>
      <ListRow icon={SmartphoneIcon} onClick={() => void promptInstall()} data-testid="install-app">
        {de.pwa.install}
      </ListRow>
    </div>
  );
}
