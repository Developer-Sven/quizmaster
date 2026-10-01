/**
 * Letztes Spielende einer Lobby (ADR-038): Nach dem Ergebnis geht es automatisch zurück in die Lobby; dort zeigt
 * die Karte „Letztes Spiel“ Rangliste, Spielverlauf und – für Mitspielende – „Fragen ansehen“. Grundlage ist der
 * öffentliche Zustand beim Spielende (Phase `game_over`), denn in der Lobby fehlen Ausgeschiedene und Ergebnis.
 * Pro Tab im sessionStorage gemerkt, damit ein Neuladen in der Lobby nichts verliert.
 */
import { type PublicLobbyState, publicLobbyStateSchema } from "@quizmaster/shared";
import { object, string } from "zod";
import { isRunningPhase } from "./game-view";
import { readStoredLastGame, writeStoredLastGame } from "./storage";

export interface LastGameSnapshot {
  /** Lobby-Code */
  code: string;
  /** öffentlicher Zustand beim Spielende (Phase `game_over`, mit `results`) */
  state: PublicLobbyState;
  /** eigene playerId in diesem Spiel; `null` = nicht mitgespielt (kein Rückblick) */
  selfId: string | null;
}

const snapshotSchema = object({ code: string().max(16), state: publicLobbyStateSchema, selfId: string().nullable() });

/**
 * Nächster Stand nach einem neuen `lobby:state`: Spielende → neuer Schnappschuss; laufendes Spiel → keiner;
 * sonst (Lobby derselben Lobby) bleibt der bisherige.
 */
export function nextLastGame(
  previous: LastGameSnapshot | null,
  next: PublicLobbyState,
  selfId: string | null,
): LastGameSnapshot | null {
  if (next.phase === "game_over" && next.results !== null) {
    const played = selfId !== null && next.results.ranking.some((entry) => entry.playerId === selfId);
    return { code: next.code, state: next, selfId: played ? selfId : null };
  }
  if (isRunningPhase(next.phase)) return null;
  return previous?.code === next.code ? previous : null;
}

export function saveLastGame(snapshot: LastGameSnapshot | null): void {
  writeStoredLastGame(snapshot === null ? null : JSON.stringify(snapshot));
}

/** Gespeicherter Schnappschuss dieser Lobby – oder `null` (fehlt, andere Lobby, ungültig). */
export function loadLastGame(code: string): LastGameSnapshot | null {
  const raw = readStoredLastGame();
  if (raw === null) return null;
  try {
    const parsed = snapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.code !== code || parsed.data.state.phase !== "game_over") return null;
    return parsed.data;
  } catch (error) {
    console.warn("Letztes Spiel nicht lesbar:", error instanceof Error ? error.name : "unbekannt");
    return null;
  }
}
