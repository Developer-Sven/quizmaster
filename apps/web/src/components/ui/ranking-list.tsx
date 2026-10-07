import { de } from "../../i18n/de";
import { cx } from "../../lib/ui/cx";
import type { PlayerColor } from "../../lib/ui/player";
import { Avatar } from "./avatar";

export interface RankingEntry {
  playerId: string;
  /** Platz vom Server; gleiche Punkte = gleicher Platz */
  place: number;
  name: string;
  color: PlayerColor;
  score: number;
  status: "active" | "resigned";
}

export interface RankingListProps {
  entries: readonly RankingEntry[];
}

/**
 * RankingList (docs/09 §5): Platz (tabular) · Avatar · Name · Punkte. Aufgegeben: Avatar 40 %,
 * Name durchgestrichen, „Aufgegeben“ in `caption` (Text bleibt für den Kontrast in `text-2`).
 */
export function RankingList({ entries }: RankingListProps) {
  return (
    <ol aria-label={de.result.ranking} className="flex flex-col">
      {entries.map((entry) => {
        const resigned = entry.status === "resigned";
        return (
          <li key={entry.playerId} className="flex min-h-14 items-center gap-3 border-b border-line py-2">
            <span className="w-6 shrink-0 text-right text-label text-text-2 tabular-nums">
              <span className="sr-only">{de.a11y.placeColumn} </span>
              {entry.place}
            </span>
            <Avatar name={entry.name} color={entry.color} size={40} resigned={resigned} />
            <span className="flex min-w-0 flex-1 flex-col">
              {/* Der Name wird nie abgeschnitten – bei großer Schrift bricht er um (docs/09 §12, WCAG 1.4.4). */}
              <span className={cx("text-body wrap-break-word", resigned ? "text-text-2 line-through" : "text-text")}>
                {entry.name}
              </span>
              {resigned ? <span className="text-caption text-text-2">{de.result.resigned}</span> : null}
            </span>
            <span className={cx("shrink-0 text-label tabular-nums", resigned ? "text-text-2" : "text-text")}>
              {entry.score}
              <span className="sr-only"> {de.a11y.pointsColumn}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
