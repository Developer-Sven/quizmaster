import type { ReactNode } from "react";

export interface StatusLineProps {
  /** Inhalt der Zeile; leer bleibt sie trotzdem gleich hoch (reserviert) */
  children?: ReactNode;
  /** Live-Region (höflich): die Frage zählt „Warte auf 2 weitere …“ herunter */
  live?: boolean;
  testId: string;
}

/**
 * Statuszeile direkt **unter** der Fragekarte (ADR-034, docs/09 §7.5–7.6): `caption` in `text-2`, zentriert, in
 * Frage und Auflösung dieselbe Komponente mit derselben reservierten Höhe (16 px, auch leer). Die Frage zeigt hier
 * „Warte auf 2 weitere …“, die Auflösung ohne eigene Antwort „Zeit abgelaufen“ mit `timer`-Icon (16). Karte und
 * Antworten stehen so beim Übergang Frage → Auflösung („cut“) still – mit und ohne eigene Antwort.
 */
export function StatusLine({ children, live = false, testId }: StatusLineProps) {
  return (
    <p
      aria-live={live ? "polite" : undefined}
      data-testid={testId}
      className="mt-1 flex min-h-4 items-center justify-center gap-1 text-center text-caption text-text-2"
    >
      {children}
    </p>
  );
}
