/**
 * lobbies (docs/04): Snapshots für Wiederaufnahme und Code-Eindeutigkeit. Codes sind nur unter
 * AKTIVEN Lobbys eindeutig (partieller Unique-Index) – `insert` meldet Kollisionen als Ergebnis,
 * damit der Realtime-Server einen neuen Code ziehen kann. `save` schreibt nie einen älteren Stand
 * (`rev`) über einen neueren.
 */
import { lobbyCodeSchema } from "@quizmaster/shared";
import {
  documentIdSchema,
  type LobbyDoc,
  lobbyDocSchema,
  ownerGuestIdSchema,
  RETENTION,
} from "@quizmaster/shared/documents";
import type { ClientSession, Collection } from "mongodb";
import { isDuplicateKeyError } from "../errors.ts";

export type LobbyInsertResult = { ok: true } | { ok: false; reason: "code_taken" };
export type LobbySaveResult = "saved" | "stale" | "code_taken";

/** TTL einer aktiven Lobby: updatedAt + 30 min. */
export function activeLobbyExpiresAt(updatedAt: Date): Date {
  return new Date(updatedAt.getTime() + RETENTION.activeLobbyMs);
}

/** TTL einer beendeten Lobby: endedAt + 2 h. */
export function endedLobbyExpiresAt(endedAt: Date): Date {
  return new Date(endedAt.getTime() + RETENTION.endedLobbyMs);
}

export interface LobbiesRepo {
  /** Neue Lobby; `code_taken`, wenn eine andere AKTIVE Lobby den Code hat. */
  insert(lobby: LobbyDoc): Promise<LobbyInsertResult>;
  /** Snapshot schreiben (Upsert); `stale`, wenn in der DB bereits ein neuerer `rev` steht. */
  save(lobby: LobbyDoc, session?: ClientSession): Promise<LobbySaveResult>;
  /** Code-Lookup (nutzt den partiellen Unique-Index). */
  findActiveByCode(code: string): Promise<LobbyDoc | null>;
  isCodeTaken(code: string): Promise<boolean>;
  findById(lobbyId: string): Promise<LobbyDoc | null>;
  /** Aktive gehostete Lobbys eines Gasts („max. 1 aktive Lobby pro Host“). */
  countActiveHostedBy(guestId: string): Promise<number>;
  /** Alle aktiven Lobbys (Wiederaufnahme nach Neustart). */
  listActive(): Promise<LobbyDoc[]>;
  /** Lobby schließen → Code frei; Aufbewahrung bis `endedAt + 2 h`. */
  close(lobbyId: string, endedAt: Date): Promise<boolean>;
}

export function createLobbiesRepo(lobbies: Collection<LobbyDoc>): LobbiesRepo {
  return {
    async insert(lobby) {
      try {
        await lobbies.insertOne(lobbyDocSchema.parse(lobby));
        return { ok: true };
      } catch (error) {
        if (isDuplicateKeyError(error, "code")) return { ok: false, reason: "code_taken" };
        throw error;
      }
    },

    async save(lobby, session) {
      const doc = lobbyDocSchema.parse(lobby);
      try {
        await lobbies.replaceOne({ _id: doc._id, rev: { $lte: doc.rev } }, doc, { upsert: true, session });
        return "saved";
      } catch (error) {
        // Upsert-Konflikt auf _id: Dokument existiert mit höherem rev → nichts überschreiben.
        if (isDuplicateKeyError(error, "_id")) return "stale";
        if (isDuplicateKeyError(error, "code")) return "code_taken";
        throw error;
      }
    },

    async findActiveByCode(code) {
      return lobbies.findOne({ code: lobbyCodeSchema.parse(code), active: true });
    },

    async isCodeTaken(code) {
      const found = await lobbies.findOne(
        { code: lobbyCodeSchema.parse(code), active: true },
        { projection: { _id: 1 } },
      );
      return found !== null;
    },

    async findById(lobbyId) {
      return lobbies.findOne({ _id: documentIdSchema.parse(lobbyId) });
    },

    async countActiveHostedBy(guestId) {
      return lobbies.countDocuments({ createdByGuestId: ownerGuestIdSchema.parse(guestId), active: true });
    },

    async listActive() {
      return lobbies.find({ active: true }).toArray();
    },

    async close(lobbyId, endedAt) {
      const result = await lobbies.updateOne(
        { _id: documentIdSchema.parse(lobbyId) },
        { $set: { active: false, updatedAt: endedAt, expiresAt: endedLobbyExpiresAt(endedAt) } },
      );
      return result.matchedCount === 1;
    },
  };
}
