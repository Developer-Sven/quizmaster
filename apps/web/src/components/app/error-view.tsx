import type { ReactNode, Ref } from "react";
import { de } from "../../i18n/de";
import { type LucideIcon, TriangleAlertIcon } from "../../lib/ui/icons";
import { BUTTON_LABEL_CLASSES, buttonClasses } from "../ui/button-styles";
import { EmptyState } from "../ui/empty-state";
import { AppFooter } from "./app-footer";

export interface ErrorViewProps {
  /** eine Zeile, z. B. „Lobby nicht gefunden.“ */
  message: string;
  /** Icon 40 in `text-3` (Standard `triangle-alert`) */
  icon?: LucideIcon;
  /** Aktion statt „Zur Startseite“ (z. B. „Erneut versuchen“) */
  action?: ReactNode;
  testId?: string;
  /**
   * Ersetzt die Ansicht eine laufende Seite (z. B. „Du wurdest entfernt.“), bekommt die Überschrift den Fokus –
   * sonst fiele er auf `body` und Screenreader sagten nichts an (WCAG 2.4.3, 4.1.3). Macht sie fokussierbar.
   */
  headingRef?: Ref<HTMLHeadingElement>;
}

/**
 * „Zur Startseite“ im Button-Look als einfacher Link (volle Navigation): Fehlerseiten kommen so ohne `next/link`
 * und das Button-Modul aus – ihre Chunks laden mit dem Layout auf jeder Seite (docs/07).
 */
export function ToStartLink({ variant }: { variant: "primary" | "ghost" }) {
  return (
    <a href="/" className={buttonClasses(variant, "default", true)}>
      <span className={BUTTON_LABEL_CLASSES}>{de.actions.toStart}</span>
    </a>
  );
}

/**
 * Fehler- und Sonderseite (docs/09 §6): `EmptyState` + ein Button („Zur Startseite“), senkrecht
 * zentriert in der Inhaltsspalte, unten die Fußzeile mit „Regeln“ (Fehler-, 404- und Offline-Seite).
 * Auch als Server-Komponente nutzbar (not-found).
 */
export function ErrorView({
  message,
  icon = TriangleAlertIcon,
  action,
  testId = "error-view",
  headingRef,
}: ErrorViewProps) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-column flex-col px-gutter pt-safe">
      <main data-testid={testId} className="flex flex-1 flex-col justify-center">
        <EmptyState
          icon={icon}
          as="h1"
          message={message}
          headingRef={headingRef}
          action={action ?? <ToStartLink variant="primary" />}
        />
      </main>
      <AppFooter safeArea />
    </div>
  );
}
