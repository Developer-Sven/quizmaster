"use client";

import { useEffect } from "react";
import { ErrorView } from "@/components/app/error-view";
import { Button, ButtonLink } from "@/components/ui/button";
import { de, errorPresentations } from "@/i18n/de";

interface RootErrorProps {
  error: Error & { digest?: string };
  retry: () => void;
}

/**
 * Fehlerseite für unerwartete Fehler (docs/09 §6, §11): allgemeiner Text statt technischer Details,
 * „Erneut versuchen“ und „Zur Startseite“. Geloggt wird nur die Kennung (`digest`), keine Inhalte.
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
          <Button variant="primary" block onClick={retry}>
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
