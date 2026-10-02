import { de } from "../../i18n/de";

/**
 * Die Regeln als nummerierte Liste (docs/09 §6: höchstens 6 kurze Punkte, Inhalt nach docs/01) – auf der Seite
 * `/regeln` und im Regeln-Sheet von Lobby und Spielende (ADR-052).
 */
export function RulesList() {
  return (
    <ol data-testid="rules-list" className="list-decimal space-y-4 pl-6 text-body text-text marker:text-text-2">
      {de.rules.points.map((point) => (
        <li key={point}>{point}</li>
      ))}
    </ol>
  );
}
