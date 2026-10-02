/**
 * Ergebnis aus Sicht der eigenen Person (docs/09 §6, §7.9, §11) und die Ansage der HUD-Live-Region
 * (docs/09 §7 „Screenreader“). Reine Funktionen, die Bühne, Spielende-Overlay und Cues gemeinsam nutzen –
 * bewusst außerhalb der Overlay-Chunks, damit das HUD sie ohne Nachladen kennt.
 */
import type { PublicLobbyState, PublicPlayer } from "@quizmaster/shared";
import { de } from "../../i18n/de";
import {
  announcementFor,
  type CategoryCatalog,
  duelOutcome,
  findPlayer,
  gameParticipants,
} from "../../lib/client/game-view";
import type { RankingEntry } from "../ui/ranking-list";

type GameResults = NonNullable<PublicLobbyState["results"]>;

export type OwnOutcome = "won" | "lost" | "draw";

/**
 * Eigenes Ergebnis (Ton am Spielende): Platz 1 = gewonnen, Gleichstand aller Aktiven = unentschieden,
 * sonst (auch aufgegeben) verloren; `null` für Personen ohne Platz (nicht im Spiel).
 */
export function ownOutcome(results: GameResults, selfId: string | null): OwnOutcome | null {
  const own = results.ranking.find((entry) => entry.playerId === selfId);
  if (!own) return null;
  if (own.status !== "active") return "lost";
  if (results.outcome === "draw") return "draw";
  return own.place === 1 ? "won" : "lost";
}

/** Überschrift des Spielendes aus Sicht der eigenen Person (docs/09 §11 Ergebnis-Texte). */
export function resultHeadline(
  results: GameResults,
  participants: readonly PublicPlayer[],
  selfId: string | null,
): string {
  if (participants.length === 2) {
    const outcome = duelOutcome(results, selfId);
    if (outcome === "won") return de.result.won;
    if (outcome === "lost") return de.result.lost;
    if (outcome === "draw") return de.result.draw;
  }
  const own = results.ranking.find((entry) => entry.playerId === selfId);
  if (own) {
    if (own.status === "resigned") return de.result.resigned;
    if (results.outcome === "draw") return de.result.draw;
    return own.place === 1 ? de.result.won : de.result.place(own.place);
  }
  const winners = results.ranking.filter((entry) => entry.place === 1 && entry.status === "active");
  const winner = winners.length === 1 ? findPlayer(participants, winners[0]?.playerId) : undefined;
  return winner ? de.result.playerWins(winner.name) : de.result.draw;
}

/**
 * Text der höflichen Live-Region im HUD: Runde/Wahl, Kategorie + Frage x/K, Richtig/Falsch mit richtiger
 * Antwort, Rundenende mit Platz (docs/09 §7) – dazu am Spielende das eigene Ergebnis.
 */
export function stageAnnouncement(
  state: PublicLobbyState,
  selfId: string | null,
  catalog: CategoryCatalog,
): string | null {
  if (state.phase === "game_over") {
    return state.results
      ? de.announcements.gameEnded(resultHeadline(state.results, gameParticipants(state), selfId))
      : null;
  }
  return announcementFor(state, selfId, catalog);
}

/** Ranglisten-Einträge mit Name und Farbe aus den Personen des Spiels (auch Aufgegebene). */
export function rankingEntries(results: GameResults, participants: readonly PublicPlayer[]): RankingEntry[] {
  return results.ranking.flatMap((entry) => {
    const player = findPlayer(participants, entry.playerId);
    if (!player) return [];
    return [
      {
        playerId: entry.playerId,
        place: entry.place,
        name: player.name,
        color: player.color,
        score: entry.score,
        // Im Ergebnis stehen nur Mitspielende – nie der anzeigende Host (ADR-046).
        status: entry.status === "resigned" ? ("resigned" as const) : ("active" as const),
      },
    ];
  });
}
