"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { de } from "../../i18n/de";
import { SmartphoneIcon } from "../../lib/ui/icons";
import { ListRow } from "../ui/list-row";
import { promptInstall, useInstallMethod } from "./install-state";

/**
 * Anleitungs-Sheet nur für iOS und erst bei Bedarf laden: Das Sheet bringt motion mit, die Startseite bleibt
 * ohne Animations-Code (docs/07 „wenig JS“). Geladen wird es, sobald die Zeile für iOS sichtbar ist.
 */
const IosInstallSheet = dynamic(() => import("./ios-install-sheet").then((module) => module.IosInstallSheet), {
  ssr: false,
});

/**
 * Zeile „Als App installieren“ (`smartphone`) über dem Footer der Startseite (docs/09 §6, docs/10): nur nach
 * dem ersten beendeten Spiel, nur wenn installierbar und noch nicht installiert. Android/Chromium öffnet den
 * Installationsdialog des Browsers, iOS eine Anleitung („Teilen“ → „Zum Home-Bildschirm“). Kein Pop-up.
 */
export function InstallRow() {
  const method = useInstallMethod();
  const [guideOpen, setGuideOpen] = useState(false);
  if (method === null) return null;

  const install = () => {
    if (method === "prompt") void promptInstall();
    else setGuideOpen(true);
  };

  return (
    <div data-testid="install-row" data-method={method}>
      <ListRow icon={SmartphoneIcon} onClick={install} data-testid="install-app">
        {de.pwa.install}
      </ListRow>
      {method === "ios-guide" ? <IosInstallSheet open={guideOpen} onClose={() => setGuideOpen(false)} /> : null}
    </div>
  );
}
