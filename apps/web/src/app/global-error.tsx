"use client";

import { useEffect } from "react";
import { ErrorView, ToStartLink } from "@/components/app/error-view";
import { BUTTON_LABEL_CLASSES, buttonClasses } from "@/components/ui/button-styles";
import { de, errorPresentations } from "@/i18n/de";
import { reloadPage } from "@/lib/client/reload";
import { rubik } from "./fonts";
import "./globals.css";

interface GlobalErrorProps {
  error: Error & { digest?: string };
  retry: () => void;
}

/**
 * Fehler im Wurzel-Layout (docs/09 §6, §11): allgemeiner Text, „Erneut versuchen“ (lädt die Seite neu – das
 * Layout selbst ist gescheitert) und „Zur Startseite“. Next rendert diese Datei zusätzlich als rein statische
 * 500-Seite vor; dort tragen die Skripte keine Nonce – „Zur Startseite“ ist deshalb ein normaler Link und
 * funktioniert auch ohne JavaScript. Geloggt wird nur die Kennung (`digest`), keine Inhalte.
 * Bewusst schlank (schlichte `<button>`/`<a>` mit den Button-Klassen, Schrift aus `./fonts`): Ihr Chunk lädt mit
 * dem Layout auf jeder Seite (docs/07 Initial-JS).
 */
export default function GlobalError({ error }: GlobalErrorProps) {
  useEffect(() => {
    console.error("Unerwarteter Fehler:", error.digest ?? error.name);
  }, [error]);

  return (
    <html lang="de" className={rubik.variable}>
      <body className="min-h-dvh bg-bg text-body text-text antialiased">
        <ErrorView
          testId="global-error"
          message={errorPresentations.INTERNAL.text}
          action={
            <div className="flex w-full flex-col gap-3">
              <button type="button" className={buttonClasses("primary", "default", true)} onClick={reloadPage}>
                <span className={BUTTON_LABEL_CLASSES}>{de.actions.retry}</span>
              </button>
              <ToStartLink variant="ghost" />
            </div>
          }
        />
      </body>
    </html>
  );
}
