"use client";

import { useState } from "react";
import { de } from "../../i18n/de";
import { SmartphoneIcon } from "../../lib/ui/icons";
import { ListRow } from "../ui/list-row";
import { installSteps } from "./install-guide";
import { InstallSheet } from "./install-sheet";
import { promptInstall, useInstallOffer } from "./install-state";

/**
 * Zeile „Als App installieren“ (`smartphone`) über dem Footer der Startseite (docs/09 §6, ADR-040, ADR-054): auf
 * jedem Handy, solange die App nicht installiert ist. Kann der Browser selbst installieren (Chromium mit
 * `beforeinstallprompt`), öffnet ein Tipp sofort seinen Dialog; sonst (iPhone/iPad, Android ohne Dialog) das Sheet
 * mit den drei Schritten für diesen Browser. Am Desktop nur mit Installationsdialog.
 */
export function InstallRow() {
  const offer = useInstallOffer();
  const [open, setOpen] = useState(false);
  if (offer === null) return null;
  const { method, browser } = offer;
  return (
    <div data-testid="install-row" data-method={method}>
      <ListRow
        icon={SmartphoneIcon}
        onClick={() => {
          if (method === "prompt") void promptInstall();
          else setOpen(true);
        }}
        data-testid="install-app"
      >
        {de.pwa.install}
      </ListRow>
      {method === "prompt" ? null : (
        <InstallSheet open={open} steps={installSteps(method, browser)} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
