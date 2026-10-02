import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import { RULES_URL } from "../../sw/protocol";

export interface RulesLinkProps {
  /**
   * Lobby und Spielende (ADR-052): öffnet das Regeln-Sheet statt einer Seite. Wer die Lobby-Seite verlässt – auch
   * über einen neuen Tab, der am Handy und in der installierten App den Lobby-Tab verdrängt –, ist getrennt und
   * wird nach der Reconnect-Frist entfernt (Lobby 30 s, nach dem Spiel 90 s).
   */
  onOpen?: () => void;
}

const RULES_LINK_CLASS =
  "inline-flex min-h-12 min-w-12 items-center justify-center rounded-sm px-3 text-caption text-text-3 underline underline-offset-4 transition-control is-hover:text-text-2";

/**
 * „Regeln“ (docs/09 §6: `caption`, `text-3`) mit 48-px-Trefferfläche (docs/09 §12) und sichtbarem Fokus-Ring
 * (global). Ohne `onOpen` ein normaler Link statt `next/link`: Die Dokument-Navigation läuft über den Service
 * Worker, der die Regeln für die Offline-Seite bereithält und bei jedem Aufruf auffrischt (src/sw). Mit `onOpen`
 * ein Knopf, der das Regeln-Sheet öffnet (`aria-haspopup="dialog"`).
 */
export function RulesLink({ onOpen }: RulesLinkProps) {
  if (onOpen) {
    return (
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={onOpen}
        data-testid="rules-link"
        className={RULES_LINK_CLASS}
      >
        {de.rules.title}
      </button>
    );
  }
  return (
    <a href={RULES_URL} data-testid="rules-link" className={RULES_LINK_CLASS}>
      {de.rules.title}
    </a>
  );
}

export interface AppFooterProps {
  /** Lobby und Spielende: Regeln als Sheet öffnen (ADR-052) statt die Seite zu wechseln */
  onShowRules?: () => void;
  /** unterster Block einer Seite ohne Aktionsleiste (Start, Fehlerseiten): hält Abstand zur Safe Area unten */
  safeArea?: boolean;
}

/**
 * Fußzeile mit „Regeln“ (docs/09 §6) – auf Start, Fehler-, 404- und Offline-Seite als Link auf `/regeln`, in
 * Lobby und Spielende als Sheet (ADR-052); im laufenden Spiel nie. Impressum und Datenschutz entfallen vorerst
 * (ADR-030).
 */
export function AppFooter({ onShowRules, safeArea = false }: AppFooterProps) {
  return (
    <footer className={cx("flex justify-center", safeArea && "pb-safe")}>
      <RulesLink onOpen={onShowRules} />
    </footer>
  );
}
