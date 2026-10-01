"use client";

import { useId, useState } from "react";
import { LiveReviewSheet } from "@/components/game/live-review-sheet";
import { ListRow } from "@/components/ui/list-row";
import { de } from "@/i18n/de";
import type { CategoryCatalog } from "@/lib/client/game-view";
import type { LastGameSnapshot } from "@/lib/client/last-game";
import { CrownIcon, ListChecksIcon } from "@/lib/ui/icons";
import { LastGameSheet } from "./last-game-sheet";

export interface LastGameCardProps {
  lastGame: LastGameSnapshot;
  categories: CategoryCatalog;
  realtimeUrl: string;
}

/**
 * Karte „Letztes Spiel“ in der Lobby (ADR-038): Nach dem Ergebnis geht es automatisch zurück in die Lobby; hier
 * lassen sich Ergebnis (Rangliste + Spielverlauf) und – für Mitspielende – „Fragen ansehen“ mit Bewerten und Melden
 * noch einmal öffnen, während der Host einlädt, Einstellungen ändert und die nächste Runde startet.
 */
export function LastGameCard({ lastGame, categories, realtimeUrl }: LastGameCardProps) {
  const headingId = useId();
  const [open, setOpen] = useState<"result" | "review" | null>(null);
  const played = lastGame.selfId !== null;
  return (
    <section aria-labelledby={headingId} data-testid="lobby-last-game" className="flex flex-col gap-1">
      <h2 id={headingId} className="text-label text-text-2">
        {de.lobby.lastGame}
      </h2>
      <div className="flex flex-col">
        <ListRow icon={CrownIcon} onClick={() => setOpen("result")} data-testid="lobby-last-result">
          {de.actions.showResult}
        </ListRow>
        {played ? (
          <ListRow icon={ListChecksIcon} onClick={() => setOpen("review")} data-testid="lobby-last-review">
            {de.actions.reviewQuestions}
          </ListRow>
        ) : null}
      </div>
      <LastGameSheet
        open={open === "result"}
        lastGame={lastGame}
        categories={categories}
        onClose={() => setOpen(null)}
      />
      {played ? (
        <LiveReviewSheet
          open={open === "review"}
          realtimeUrl={realtimeUrl}
          onClose={() => setOpen(null)}
          players={lastGame.state.players}
          selfId={lastGame.selfId}
        />
      ) : null}
    </section>
  );
}
