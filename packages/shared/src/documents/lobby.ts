import { z } from "zod";
import { PHASES, PLAYER_COLORS, PLAYER_STATUSES } from "../constants.ts";
import { displayNameSchema, lobbyCodeSchema, playerIdSchema } from "../primitives.ts";
import { GAME_RULES, lobbySettingsSchema } from "../settings.ts";

/** Server-interne ID (lobbyId, gameId, reportId, banId …): zufällig, 1–64 Zeichen. */
export const documentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * guestId in Server-Dokumenten. Menschen: UUID; Dev-Bots haben keinen Gast und bekommen eine
 * synthetische ID (z. B. „bot:…“). Nur Server – nie in Client-Payloads.
 */
export const ownerGuestIdSchema = z.string().min(1).max(64);

/** Person in einem Lobby-Snapshot (nur Server – enthält die guestId). */
export const playerSnapshotSchema = z.object({
  playerId: playerIdSchema,
  guestId: ownerGuestIdSchema,
  name: displayNameSchema,
  color: z.enum(PLAYER_COLORS),
  isBot: z.boolean(),
  joinedAt: z.date(),
  status: z.enum(PLAYER_STATUSES),
  score: z.int().min(0),
});
export type PlayerSnapshot = z.output<typeof playerSnapshotSchema>;

/**
 * Snapshot des laufenden Spiels (order, progress, turn, aktuelle Fragen inkl. richtigem Index, board).
 * Die Form gehört der Engine (`packages/game-engine`), die ihn beim Laden selbst validiert.
 */
export const gameSnapshotSchema = z.record(z.string(), z.unknown());
export type GameSnapshot = z.output<typeof gameSnapshotSchema>;

/** lobbies – Lobby-Snapshots für Wiederaufnahme und Code-Eindeutigkeit. */
export const lobbyDocSchema = z.object({
  _id: documentIdSchema,
  /** 6 Zeichen, eindeutig unter aktiven Lobbys (partieller Unique-Index). */
  code: lobbyCodeSchema,
  /** false = geschlossen → Code frei. */
  active: z.boolean(),
  phase: z.enum(PHASES),
  /** Steigt bei jeder Zustandsänderung. */
  rev: z.int().min(0),
  settings: lobbySettingsSchema,
  createdByGuestId: ownerGuestIdSchema,
  hostPlayerId: playerIdSchema,
  players: z.array(playerSnapshotSchema).max(GAME_RULES.maxPlayersPerLobby),
  bannedGuestIds: z.array(ownerGuestIdSchema),
  game: gameSnapshotSchema.nullable(),
  /** Scale-out (Phase 6+). */
  owner: z.object({ instanceId: z.string().min(1).max(128), leaseUntil: z.date() }).optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
  /** Aktiv: updatedAt + 30 min; beendet: endedAt + 2 h (TTL). */
  expiresAt: z.date(),
});
export type LobbyDoc = z.output<typeof lobbyDocSchema>;
