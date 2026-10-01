"use client";

import { Rubik } from "next/font/google";
import { useEffect } from "react";
import { ErrorView } from "@/components/app/error-view";
import { Button, ButtonLink } from "@/components/ui/button";
import { de, errorPresentations } from "@/i18n/de";
import { reloadPage } from "@/lib/client/reload";
import "./globals.css";

/** Wie im Wurzel-Layout (docs/09 §3) – die globale Fehlerseite ersetzt das Layout samt `<html>`. */
const rubik = Rubik({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-rubik",
});

interface GlobalErrorProps {
  error: Error & { digest?: string };
  retry: () => void;
}

/**
 * Fehler im Wurzel-Layout (docs/09 §6, §11): allgemeiner Text, „Erneut versuchen“ (lädt die Seite neu – das
 * Layout selbst ist gescheitert) und „Zur Startseite“. Next rendert diese Datei zusätzlich als rein statische
 * 500-Seite vor; dort tragen die Skripte keine Nonce – „Zur Startseite“ ist deshalb ein normaler Link und
 * funktioniert auch ohne JavaScript. Geloggt wird nur die Kennung (`digest`), keine Inhalte.
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
              <Button variant="primary" block onClick={reloadPage}>
                {de.actions.retry}
              </Button>
              <ButtonLink variant="ghost" href="/" block>
                {de.actions.toStart}
              </ButtonLink>
            </div>
          }
        />
      </body>
    </html>
  );
}
