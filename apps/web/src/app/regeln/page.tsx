import type { Metadata } from "next";
import { AppHeader, HeaderTitle } from "../../components/app/app-header";
import { AppShell } from "../../components/app/app-shell";
import { ButtonLink } from "../../components/ui/button";
import { de } from "../../i18n/de";

export const metadata: Metadata = {
  title: de.rules.title,
};

/**
 * Regeln `/regeln` (docs/09 §6: höchstens 6 kurze Punkte, Inhalt nach docs/01): ruhige Seite im App-Shell –
 * Kopfzeile mit Titel, nummerierte Liste, unten „Zur Startseite“ (sekundär, keine orange Hauptaktion). Ohne
 * Client-Logik; der Rückweg ist ein normaler Link und funktioniert auch ohne JavaScript. Dynamisch gerendert wie
 * jede Seite (Wurzel-Layout, CSP-Nonce, ADR-008). Der Service Worker hält sie für die Offline-Seite bereit.
 */
export default function RulesPage() {
  return (
    <AppShell
      testId="rules-page"
      header={<AppHeader title={<HeaderTitle>{de.rules.title}</HeaderTitle>} />}
      actions={
        <ButtonLink variant="secondary" href="/" block data-testid="rules-to-start">
          {de.actions.toStart}
        </ButtonLink>
      }
    >
      <ol data-testid="rules-list" className="list-decimal space-y-4 pl-6 text-body text-text marker:text-text-2">
        {de.rules.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ol>
    </AppShell>
  );
}
