"use client";

import { type ComponentType, useEffect, useState } from "react";
import { de } from "../../i18n/de";
import { SmartphoneIcon } from "../../lib/ui/icons";
import { ListRow } from "../ui/list-row";
import { installSteps } from "./install-guide";
import { promptInstall, useInstallOffer } from "./install-state";

type InstallSheetComponent = typeof import("./install-sheet").InstallSheet;

/**
 * Anleitungs-Sheet nachladen (wie das QR-Sheet der Startseite): Das Sheet bringt motion mit, die Startseite bleibt
 * ohne Animations-Code und im Budget aus ADR-037 (docs/07 „wenig JS“). Ein gescheiterter Download (offline) wird nicht
 * gemerkt – der nächste Tipp versucht es erneut, statt dass die Fehlerseite die ganze Startseite ersetzt.
 */
let sheetModule: Promise<typeof import("./install-sheet")> | null = null;
function loadInstallSheet(): Promise<typeof import("./install-sheet")> {
  sheetModule ??= import("./install-sheet").catch((error: unknown) => {
    sheetModule = null;
    throw error;
  });
  return sheetModule;
}

/**
 * Zeile „Als App installieren“ (`smartphone`) über dem Footer der Startseite (docs/09 §6, ADR-040, ADR-054): auf
 * jedem Handy, solange die App nicht installiert ist. Kann der Browser selbst installieren (Chromium mit
 * `beforeinstallprompt`), öffnet ein Tipp sofort seinen Dialog; sonst (iPhone/iPad, Android ohne Dialog) das Sheet
 * mit den drei Schritten für diesen Browser. Am Desktop nur mit Installationsdialog.
 */
export function InstallRow() {
  const offer = useInstallOffer();
  const [Sheet, setSheet] = useState<ComponentType<Parameters<InstallSheetComponent>[0]> | null>(null);
  const [open, setOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const guide = offer !== null && offer.method !== "prompt";
  // Im Leerlauf vorwärmen, solange die Anleitung gebraucht wird: Dann liegt das Sheet im Cache des Service Workers und
  // öffnet auch offline. Scheitert das (schon offline), lädt der Tipp selbst erneut und zeigt dort den Hinweis.
  useEffect(() => {
    if (!guide) return;
    const warm = () => {
      loadInstallSheet().catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(warm, { timeout: 5_000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(warm, 2_000);
    return () => window.clearTimeout(timer);
  }, [guide]);
  if (offer === null) return null;
  const { method, browser } = offer;
  return (
    <div data-testid="install-row" data-method={method}>
      <ListRow
        icon={SmartphoneIcon}
        onClick={() => {
          if (method === "prompt") {
            void promptInstall();
            return;
          }
          setUnavailable(false);
          loadInstallSheet().then(
            (module) => {
              setSheet(() => module.InstallSheet);
              setOpen(true);
            },
            () => setUnavailable(true),
          );
        }}
        data-testid="install-app"
      >
        {de.pwa.install}
      </ListRow>
      {unavailable ? (
        <p role="status" className="px-4 text-caption text-text-2" data-testid="install-unavailable">
          {de.pwa.installUnavailable}
        </p>
      ) : null}
      {Sheet !== null && method !== "prompt" ? (
        <Sheet open={open} steps={installSteps(method, browser)} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}
