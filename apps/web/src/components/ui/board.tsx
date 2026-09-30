import { de } from "../../i18n/de";
import type { CategoryVisual } from "../../lib/ui/category";
import { ArrowDownIcon, ArrowUpIcon } from "../../lib/ui/icons";
import type { PlayerColor } from "../../lib/ui/player";
import { squareResult } from "../../lib/ui/results";
import { STAGGER_MS } from "../../lib/ui/tokens";
import { Avatar } from "./avatar";
import { CategoryBadge } from "./category-badge";
import { ResultSquare } from "./result-square";

export interface BoardPlayer {
  id: string;
  name: string;
  color: PlayerColor;
  /** Gesamtpunkte (Summe) */
  score: number;
  resigned?: boolean;
  /** Platzwechsel seit der letzten Runde (`arrow-up`/`arrow-down` neben der Summe) */
  rankChange?: "up" | "down" | null;
}

export interface BoardRowData {
  /** stabiler Schlüssel, z. B. `${round}-${pickerId}` */
  key: string;
  category: CategoryVisual;
  /** playerId → je Frage richtig/falsch/keine Antwort (nur aufgelöste Fragen, docs/05 `BoardRow`) */
  results: Readonly<Record<string, ReadonlyArray<boolean | null>>>;
}

export interface BoardProps {
  players: readonly BoardPlayer[];
  rows: readonly BoardRowData[];
  /** Fragen pro Zug (K) – fehlende Ergebnisse erscheinen als „offen“ */
  questionsPerTurn: number;
  /** Zeilen ab diesem Index füllen sich animiert (neueste Zeile bzw. neue Zeilen der Runde) */
  animateFromRow?: number;
  /** Name der Tafel für Screenreader (Standard „Spieltafel“), eindeutig je Seite */
  label?: string;
}

/**
 * Kästchen je Zeile einer Zelle: K ist 1–10 (ADR-017). Umbrechen nach 3 hält jede Spalte 3 Kästchen
 * breit (bei K = 3 die gewohnte Quizduell-Reihe) statt mit K zu wachsen.
 */
const SQUARES_PER_LINE = 3;

/** Füllreihenfolge neuer Zeilen: Zeilen und Personen je 40 ms, Fragen je 80 ms (docs/09 §7–8). */
export function fillDelayMs(newRowIndex: number, playerIndex: number, questionIndex: number): number {
  return (newRowIndex + playerIndex) * STAGGER_MS.list + questionIndex * STAGGER_MS.squares;
}

/**
 * Board (docs/09 §5): Tabelle – Kopf = Avatare + Summe, Zeilen = Züge (CategoryBadge kompakt),
 * Zellen = ResultSquares. Bei 6–8 Personen horizontal scrollbar, erste Spalte fixiert.
 */
export function Board({ players, rows, questionsPerTurn, animateFromRow, label = de.a11y.boardCaption }: BoardProps) {
  const questions = Array.from({ length: Math.max(0, questionsPerTurn) }, (_, position) => position);
  const lines = Array.from({ length: Math.ceil(questions.length / SQUARES_PER_LINE) }, (_, line) =>
    questions.slice(line * SQUARES_PER_LINE, (line + 1) * SQUARES_PER_LINE),
  );
  return (
    // Scroll-Region per Tastatur erreichbar (WCAG 2.1.1); relative hält absolut positionierte
    // Screenreader-Texte im Scrollbereich, damit die Seite nicht breiter wird.
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: horizontal scrollbare Tafel muss per Tastatur scrollbar sein
      tabIndex={0}
      className="relative isolate overflow-x-auto rounded-xl border border-line bg-surface-1"
    >
      <table className="w-full border-collapse">
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-1 bg-surface-1 px-2 py-3">
              <span className="sr-only">{de.a11y.boardCategory}</span>
            </th>
            {players.map((player) => (
              <th key={player.id} scope="col" className="px-1 py-3 align-top">
                <span className="flex flex-col items-center gap-1">
                  <Avatar name={player.name} color={player.color} size={32} resigned={player.resigned} />
                  {/* Status auch für Screenreader (WCAG 1.3.1) – sichtbar zeigt ihn der gedimmte Avatar */}
                  <span className="sr-only">
                    {player.resigned
                      ? `${player.name}, ${de.a11y.statusResigned}, ${de.a11y.boardTotal}`
                      : `${player.name}, ${de.a11y.boardTotal}`}
                  </span>
                  <span className="flex items-center gap-0.5 text-label text-text tabular-nums">
                    {player.score}
                    {player.rankChange === "up" ? (
                      <ArrowUpIcon role="img" aria-label={de.a11y.rankUp} size={16} className="text-text-2" />
                    ) : null}
                    {player.rankChange === "down" ? (
                      <ArrowDownIcon role="img" aria-label={de.a11y.rankDown} size={16} className="text-text-2" />
                    ) : null}
                  </span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const newRow = animateFromRow === undefined ? -1 : rowIndex - animateFromRow;
            return (
              <tr key={row.key} className="border-t border-line">
                <th scope="row" className="sticky left-0 z-1 bg-surface-1 px-2 py-2">
                  <CategoryBadge category={row.category} compact />
                </th>
                {players.map((player, playerIndex) => (
                  // Kästchen Aufgegebener bleiben voll deckend: gedimmt fielen sie unter 3:1 (WCAG 1.4.11)
                  <td key={player.id} className="px-1 py-2">
                    <span className="flex flex-col items-center gap-1">
                      {lines.map((line) => (
                        <span key={line[0]} className="flex gap-1">
                          {line.map((question) => (
                            <ResultSquare
                              key={question}
                              result={squareResult(row.results[player.id]?.[question])}
                              appearDelayMs={newRow < 0 ? undefined : fillDelayMs(newRow, playerIndex, question)}
                            />
                          ))}
                        </span>
                      ))}
                    </span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
