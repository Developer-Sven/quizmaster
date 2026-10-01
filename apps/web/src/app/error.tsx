"use client";

import { useEffect } from "react";
import { ErrorView, ToStartLink } from "@/components/app/error-view";
import { BUTTON_LABEL_CLASSES, buttonClasses } from "@/components/ui/button-styles";
import { de, errorPresentations } from "@/i18n/de";
import { isChunkLoadError } from "@/lib/client/chunk-error";
import { reloadPage } from "@/lib/client/reload";

interface RootErrorProps {
  error: Error & { digest?: string };
  retry: () => void;
}

/**
 * Fehlerseite für unerwartete Fehler (docs/09 §6, §11): allgemeiner Text statt technischer Details,
 * „Erneut versuchen“ und „Zur Startseite“. Geloggt wird nur die Kennung (`digest`), keine Inhalte.
 * Scheiterte das Nachladen von Code (Netzabbruch, neuer Deploy), lädt „Erneut versuchen“ die Seite neu –
 * `retry()` allein fände nur den gemerkten Fehlschlag des Modul-Laders wieder (Szenario 9 prüft das).
 * Bewusst schlank (schlichte `<button>`/`<a>` mit den Button-Klassen statt `Button`/`ButtonLink`): Ihr Chunk lädt
 * mit dem Layout auf jeder Seite (docs/07 Initial-JS) – und muss auch ohne nachladbare Chunks funktionieren.
 */
export default function RootError({ error, retry }: RootErrorProps) {
  useEffect(() => {
    console.error("Unerwarteter Fehler:", error.digest ?? error.name);
  }, [error]);

  return (
    <ErrorView
      testId="error-page"
      message={errorPresentations.INTERNAL.text}
      action={
        <div className="flex w-full flex-col gap-3">
          <button
            type="button"
            className={buttonClasses("primary", "default", true)}
            onClick={isChunkLoadError(error) ? reloadPage : retry}
          >
            <span className={BUTTON_LABEL_CLASSES}>{de.actions.retry}</span>
          </button>
          <ToStartLink variant="ghost" />
        </div>
      }
    />
  );
}
