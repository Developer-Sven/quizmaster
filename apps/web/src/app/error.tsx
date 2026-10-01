"use client";

import { useEffect } from "react";
import { ErrorView } from "@/components/app/error-view";
import { Button, ButtonLink } from "@/components/ui/button";
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
          <Button variant="primary" block onClick={isChunkLoadError(error) ? reloadPage : retry}>
            {de.actions.retry}
          </Button>
          <ButtonLink variant="ghost" href="/" block>
            {de.actions.toStart}
          </ButtonLink>
        </div>
      }
    />
  );
}
