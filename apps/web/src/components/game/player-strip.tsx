"use client";

import type { PublicPlayer } from "@quizmaster/shared";
import type { ReactNode } from "react";
import { Avatar } from "@/components/ui/avatar";
import { ScorePill } from "@/components/ui/score-pill";
import { de } from "@/i18n/de";
import { playersSelfFirst } from "@/lib/client/game-view";
import { cx } from "@/lib/ui/cx";

/**
 * Host-Aktion bzw. Wartehinweis in der Zone des Spielerstreifens (ADR-045/049, Lage nach ADR-060) – nie eine zweite
 * Leiste darunter, die der Bühne die Höhe nimmt (bei 360 × 740 verdeckte sie Antwort D).
 */
export interface StripAction {
  /** kompakter Button (44 px) bzw. Hinweis „Warte auf Mia …“ (`ActionBarNote` kompakt) */
  content: ReactNode;
  /**
   * Lage, wenn die Bühne keine zweite Zeile verträgt (ohne `stacked`, z. B. 360 × 740):
   * - `beside`: rechts neben der Liste, die dann in der Restbreite waagerecht scrollt – eigene Person zuerst
   *   (Auflösung, Zug-Ergebnis, Zwischenstand warten auf „Weiter“).
   * - `instead`: statt der Liste über die ganze Breite – „Auflösen (2/3 Antworten)“ ist dafür zu lang (bei 360 px
   *   blieben neben ihm keine 60 px für die Personen); wie viele geantwortet haben, sagt die Beschriftung. Für
   *   Screenreader bleibt die Liste „Spielstand“ erhalten.
   */
  placement: "beside" | "instead";
}

export interface PlayerStripProps {
  players: readonly PublicPlayer[];
  selfId: string | null;
  /** Personen mit „geantwortet“-Ring (während der Frage) */
  answeredIds: readonly string[];
  /**
   * Angezeigte Punkte je Person (Choreografie: das „+1“ der Auflösung erscheint erst nach 1.200 ms,
   * docs/09 §7.6); ohne Eintrag gilt `player.score`.
   */
  scores?: Readonly<Record<string, number>>;
  /** Host-Aktion bzw. Wartehinweis in derselben Zone (statt einer Aktionsleiste darunter) */
  action?: StripAction | null;
  /**
   * Die Bühne verträgt eine zweite Zeile (hoher Viewport bzw. Fluss-Layout, ADR-060): Die Aktion steht unter der
   * Liste über die volle Breite, die Liste bleibt wie ohne Aktion – bis 4 Personen verteilt, ab 5 scrollbar.
   */
  stacked?: boolean;
}

/** Bis zu 4 Personen verteilt, ab 5 horizontal scrollbar (docs/09 §7). */
const SPREAD_MAX = 4;

/**
 * Zone des Streifens: Rahmen oben, Innenabstand und Safe Area unten – mit Liste, Liste und Aktion oder nur der
 * Aktion in einer Zeile gleich hoch (44 px Inhalt), damit die Bühne darüber nie springt; mit `stacked` kommt die
 * Zeile der Aktion darunter (8 + 44 px).
 */
const ZONE_CLASSES = "border-t border-line bg-surface-1 pt-1 pb-safe";

/** Lage der Aktion in der Zone (`data-action-layout`, ADR-060). */
export type StripActionLayout = "stacked" | StripAction["placement"];

/**
 * Spielerstreifen (docs/09 §7): Avatar 40 + ScorePill je Person, Status-Ringe (geantwortet mit Pop,
 * offline, aufgegeben), eigene Person zuerst mit 2 px orangem Unterstrich. Ersetzt im Spiel die
 * Aktionsleiste – wartet das Spiel auf den Host, steht dessen Aktion (bzw. „Warte auf Mia …“) in derselben Zone
 * ({@link StripAction}): bei genug Höhe in einer zweiten Zeile unter den Personen, sonst neben bzw. statt der Liste
 * (ADR-060). Steigt ein angezeigter Punktestand, zeigt die ScorePill „+1“ (16 px nach oben, 900 ms) und zählt hoch
 * (600 ms).
 *
 * Ab 5 Personen bzw. neben einer Aktion scrollt die Liste horizontal – ein Scroll-Container schneidet auch
 * senkrecht ab. Damit Ring (4 px über dem Avatar) und „+1“ (steigt bis 20 px über die Liste) sichtbar bleiben,
 * reicht die Liste dann per Innenabstand 20 px nach oben in die Bühne (negativer Rand, gleiche Streifenhöhe). Die
 * Liste selbst ist nicht positioniert: Die Bühne liegt in diesem Rand oben und bekommt jedes Tippen; Avatare und
 * ScorePills (positioniert) zeichnen darüber.
 */
export function PlayerStrip({
  players,
  selfId,
  answeredIds,
  scores,
  action = null,
  stacked = false,
}: PlayerStripProps) {
  const layout: StripActionLayout | null = action === null ? null : stacked ? "stacked" : action.placement;
  const ordered = playersSelfFirst(players, selfId);
  const answered = new Set(answeredIds);
  // Statt der Liste die Aktion: Die Liste bleibt nur für Screenreader – ohne Scroll-Bereich (nichts zu bedienen).
  const hidden = layout === "instead";
  // Neben der Aktion scrollt die Liste in der Restbreite; sonst gilt die Regel ohne Aktion (docs/09 §7).
  const spread = !hidden && layout !== "beside" && ordered.length <= SPREAD_MAX;
  const scrolls = !hidden && !spread;
  const list = (
    <ul
      aria-label={de.a11y.playerStrip}
      // Scrollt die Liste waagerecht, ist sie per Tastatur erreichbar (WCAG 2.1.1).
      tabIndex={scrolls ? 0 : undefined}
      className={cx(
        "flex items-center",
        // Bis 4 Personen verteilt; passen sie bei großer Schrift nicht in eine Zeile, brechen sie um.
        spread && "mx-auto min-h-11 w-full max-w-column flex-wrap justify-around gap-y-2 px-gutter",
        scrolls && "-mt-5 h-16 gap-4 overflow-x-auto overscroll-x-contain pt-5",
        // Neben einer Aktion: Restbreite (die Zeile trägt den Seitenrand), sonst die ganze Spalte.
        scrolls && (layout === "beside" ? "min-w-0 flex-1" : "mx-auto w-full max-w-column px-gutter"),
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
  );
  if (action === null || layout === null) {
    return (
      <div data-testid="player-strip" className={ZONE_CLASSES}>
        {list}
      </div>
    );
  }
  switch (layout) {
    case "stacked":
      return (
        <div data-testid="player-strip" data-action-layout={layout} className={ZONE_CLASSES}>
          {list}
          <div className="mx-auto flex w-full max-w-column flex-col px-gutter pt-2">{action.content}</div>
        </div>
      );
    case "instead":
      return (
        <div data-testid="player-strip" data-action-layout={layout} className={ZONE_CLASSES}>
          {/* Der Spielstand bleibt für Screenreader (Avatare nennen „hat geantwortet“ und die Punkte). */}
          <div className="sr-only">{list}</div>
          <div className="mx-auto flex min-h-11 w-full max-w-column items-center px-gutter">{action.content}</div>
        </div>
      );
    case "beside":
      return (
        <div data-testid="player-strip" data-action-layout={layout} className={ZONE_CLASSES}>
          <div className="mx-auto flex w-full max-w-column items-center gap-3 px-gutter">
            {list}
            <div className="flex max-w-40 shrink-0 items-center justify-end">{action.content}</div>
          </div>
        </div>
      );
  }
}
