/**
 * Snapshot für die Collection `lobbies` (docs/04 §Schemas LobbyDoc; Effect `persist`). Enthält Server-
 * Geheimnisse (guestIds, richtige Antworten im Spiel-Snapshot) – nur in die Datenbank, nie an Clients.
 * `game` ist der Engine-Spielzustand als JSON (mit `snapshotVersion`); das Wiederherstellen nach einem
 * Neustart ist Phase 6 (docs/13).
 */
import { type GameSnapshot, type LobbyDoc, RETENTION } from "@quizmaster/shared/documents";
import { computeScores } from "./scoring.ts";
import type { LobbyState } from "./types.ts";

/** Version des Spiel-Snapshots in `lobbies.game` (erhöhen, wenn sich `GameState` inkompatibel ändert). */
export const GAME_SNAPSHOT_VERSION = 1;

function expiresAt(state: LobbyState): number {
  if (state.closed !== null) return state.closed.at + RETENTION.endedLobbyMs;
  const endedAt = state.game?.endedAt ?? null;
  if (state.phase === "game_over" && endedAt !== null) return endedAt + RETENTION.endedLobbyMs;
  return state.updatedAt + RETENTION.activeLobbyMs;
}

/** LobbyDoc aus dem Zustand (ohne `owner`, das nur beim Scale-out gesetzt wird). */
export function toLobbySnapshot(state: LobbyState): LobbyDoc {
  const scores = computeScores(state.game);
  const game: GameSnapshot | null = state.game
    ? { snapshotVersion: GAME_SNAPSHOT_VERSION, ...structuredClone(state.game) }
    : null;
  return {
    _id: state.lobbyId,
    code: state.code,
    active: state.closed === null,
    phase: state.phase,
    rev: state.rev,
    settings: { ...state.settings },
    createdByGuestId: state.createdByGuestId,
    hostPlayerId: state.hostPlayerId,
    players: state.players.map((player) => ({
      playerId: player.playerId,
      guestId: player.guestId,
      name: player.name,
      color: player.color,
      isBot: player.isBot,
      joinedAt: new Date(player.joinedAt),
      status: player.status,
      score: scores.get(player.playerId) ?? 0,
    })),
    bannedGuestIds: [...state.bannedGuestIds],
    game,
    createdAt: new Date(state.createdAt),
    updatedAt: new Date(state.updatedAt),
    expiresAt: new Date(expiresAt(state)),
  };
}
