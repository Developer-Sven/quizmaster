"use client";

import type { PublicPlayer } from "@quizmaster/shared";
import { Avatar } from "@/components/ui/avatar";
import { ScorePill } from "@/components/ui/score-pill";
import { de } from "@/i18n/de";
import { playersSelfFirst } from "@/lib/client/game-view";
import { cx } from "@/lib/ui/cx";

export interface PlayerStripProps {
  players: readonly PublicPlayer[];
  selfId: string | null;
  /** Personen mit „geantwortet“-Ring (während der Frage) */
  answeredIds: readonly string[];
  /**
   * Angezeigte Punkte je Person (Choreografie: das „+1“ der Auflösung erscheint erst nach 400 ms,
   * docs/09 §7.6); ohne Eintrag gilt `player.score`.
   */
  scores?: Readonly<Record<string, number>>;
}

/** Bis zu 4 Personen verteilt, ab 5 horizontal scrollbar (docs/09 §7). */
const SPREAD_MAX = 4;

/**
 * Spielerstreifen (docs/09 §7): Avatar 40 + ScorePill je Person, Status-Ringe (geantwortet mit Pop,
 * offline, aufgegeben), eigene Person zuerst mit 2 px orangem Unterstrich. Ersetzt im Spiel die
 * Aktionsleiste. Steigt ein angezeigter Punktestand, zeigt die ScorePill „+1“ (16 px nach oben, 480 ms)
 * und zählt hoch (400 ms).
 */
export function PlayerStrip({ players, selfId, answeredIds, scores }: PlayerStripProps) {
  const ordered = playersSelfFirst(players, selfId);
  const answered = new Set(answeredIds);
  const spread = ordered.length <= SPREAD_MAX;
  return (
    <div data-testid="player-strip" className="border-t border-line bg-surface-1 pt-1 pb-safe">
      <ul
        aria-label={de.a11y.playerStrip}
        // Ab 5 Personen horizontal scrollbar – dann per Tastatur erreichbar (WCAG 2.1.1), wie die Tafel.
        tabIndex={spread ? undefined : 0}
        className={cx(
          "mx-auto flex h-11 w-full max-w-column items-center px-gutter",
          spread ? "justify-around" : "gap-4 overflow-x-auto overscroll-x-contain",
        )}
      >
        {ordered.map((player) => {
          const self = player.id === selfId;
          return (
            <li
              key={player.id}
              data-testid="strip-player"
              data-player-id={player.id}
              data-answered={answered.has(player.id) || undefined}
              className={cx(
                "flex shrink-0 items-center gap-2 border-b-2 pb-0.5",
                self ? "border-primary" : "border-transparent",
              )}
            >
              <Avatar
                name={player.name}
                color={player.color}
                size={40}
                answered={answered.has(player.id)}
                offline={!player.connected && player.status === "active"}
                resigned={player.status === "resigned"}
                label={player.name}
              />
              <ScorePill score={scores?.[player.id] ?? player.score} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
