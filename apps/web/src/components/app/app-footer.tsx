import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import { RULES_URL } from "../../sw/protocol";

export interface RulesLinkProps {
  /**
   * In neuem Tab öffnen (Lobby, Spielende): Wer die Lobby-Seite verlässt, ist getrennt und wird nach der
   * Reconnect-Frist entfernt (Lobby 30 s, nach dem Spiel 90 s) – im eigenen Tab bleibt die Lobby verbunden.
   */
  newTab?: boolean;
}

/** `target`/`rel` für einen neuen Tab – ohne Zugriff des neuen Tabs auf dieses Fenster (`noopener`). */
const NEW_TAB = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * Link „Regeln“ (docs/09 §6: `caption`, `text-3`) mit 48-px-Trefferfläche (docs/09 §12) und sichtbarem
 * Fokus-Ring (global). Bewusst ein normaler Link statt `next/link`: Die Dokument-Navigation läuft über den
 * Service Worker, der die Regeln für die Offline-Seite bereithält und bei jedem Aufruf auffrischt (src/sw).
 */
export function RulesLink({ newTab = false }: RulesLinkProps) {
  return (
    <a
      href={RULES_URL}
      data-testid="rules-link"
      {...(newTab ? NEW_TAB : {})}
      className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-sm px-3 text-caption text-text-3 underline underline-offset-4 transition-control is-hover:text-text-2"
    >
      {de.rules.title}
      {/* Leerzeichen im Span: Browser trennen absolut positionierten Text unterschiedlich – so immer genau eins */}
      {newTab ? <span className="sr-only"> {de.rules.opensNewTab}</span> : null}
    </a>
  );
}

export interface AppFooterProps extends RulesLinkProps {
  /** unterster Block einer Seite ohne Aktionsleiste (Start, Fehlerseiten): hält Abstand zur Safe Area unten */
  safeArea?: boolean;
}

/**
 * Fußzeile mit dem Link „Regeln“ (docs/09 §6) – auf Start, Fehler-, 404- und Offline-Seite, in Lobby und
 * Spielende in neuem Tab; im laufenden Spiel nie. Impressum und Datenschutz entfallen vorerst (ADR-030).
 */
export function AppFooter({ newTab = false, safeArea = false }: AppFooterProps) {
  return (
    <footer className={cx("flex justify-center", safeArea && "pb-safe")}>
      <RulesLink newTab={newTab} />
    </footer>
  );
}
