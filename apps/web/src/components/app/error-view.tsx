import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { de } from "@/i18n/de";
import { type LucideIcon, TriangleAlertIcon } from "@/lib/ui/icons";

export interface ErrorViewProps {
  /** eine Zeile, z. B. „Lobby nicht gefunden.“ */
  message: string;
  /** Icon 40 in `text-3` (Standard `triangle-alert`) */
  icon?: LucideIcon;
  /** Aktion statt „Zur Startseite“ (z. B. „Erneut versuchen“) */
  action?: ReactNode;
  testId?: string;
}

/**
 * Fehler- und Sonderseite (docs/09 §6): `EmptyState` + ein Button („Zur Startseite“), senkrecht
 * zentriert in der Inhaltsspalte. Auch als Server-Komponente nutzbar (not-found).
 */
export function ErrorView({ message, icon = TriangleAlertIcon, action, testId = "error-view" }: ErrorViewProps) {
  return (
    <main
      data-testid={testId}
      className="mx-auto flex min-h-dvh w-full max-w-column flex-col justify-center px-gutter pt-safe pb-safe"
    >
      <EmptyState
        icon={icon}
        as="h1"
        message={message}
        action={
          action ?? (
            <ButtonLink variant="primary" href="/" block>
              {de.actions.toStart}
            </ButtonLink>
          )
        }
      />
    </main>
  );
}
