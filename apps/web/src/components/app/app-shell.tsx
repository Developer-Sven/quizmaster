import type { ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import { ActionBar } from "./action-bar";

export interface AppShellProps {
  /** Kopfzeile (AppHeader) */
  header?: ReactNode;
  /** Banner unter der Kopfzeile (Wartung, Update) */
  banner?: ReactNode;
  children: ReactNode;
  /** Inhalt der Aktionsleiste unten */
  actions?: ReactNode;
  /** Test-ID des Inhaltsbereichs */
  testId?: string;
}

/**
 * App-Shell (docs/09 §4): Kopfzeile, einspaltiger Inhalt (max. 480 px, zentriert), Aktionsleiste unten.
 * Mobile first (360 × 740), ohne horizontales Scrollen. Safe Areas (docs/10): oben trägt sie die Kopfzeile,
 * unten die Aktionsleiste – ohne Aktionsleiste hält der Inhalt selbst Abstand zum Home-Indikator.
 */
export function AppShell({ header, banner, children, actions, testId }: AppShellProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      {header}
      {banner}
      <main data-testid={testId} className={cx("flex flex-1 flex-col", !actions && "pb-safe")}>
        <div className="mx-auto flex w-full max-w-column flex-1 flex-col px-gutter py-6">{children}</div>
        {actions ? <ActionBar>{actions}</ActionBar> : null}
      </main>
    </div>
  );
}
