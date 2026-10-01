"use client";

import { selectAnnouncement, useGameStore } from "../../stores/game-store";

/**
 * Live-Region der Lobby-Seite nur für Screenreader: sagt Beitritte und Austritte anderer Personen an
 * („Ben ist beigetreten.“, WCAG 4.1.3) – sichtbar ändert sich nur die Spielerliste. Bleibt dauerhaft im DOM
 * (auch im Spiel), damit neue Texte sicher angesagt werden.
 */
export function LobbyAnnouncer() {
  const announcement = useGameStore(selectAnnouncement);
  return (
    <p role="status" className="sr-only" data-testid="lobby-announcer">
      {announcement}
    </p>
  );
}
