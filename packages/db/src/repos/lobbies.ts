/**
 * lobbies (docs/04): Snapshots für Wiederaufnahme und Code-Eindeutigkeit. Codes sind nur unter
 * AKTIVEN Lobbys eindeutig (partieller Unique-Index) – `insert` meldet Kollisionen als Ergebnis,
 * damit der Realtime-Server einen neuen Code ziehen kann. `save` schreibt nie einen älteren Stand
 * (`rev`) über einen neueren und nie einen aktiven Stand über eine geschlossene Lobby: Die Engine erhöht
 * `rev` nur bei öffentlichen Änderungen, das Schließen per Timer hat daher denselben `rev` wie der letzte
 * aktive Snapshot – ohne diese Regel würde ein verspäteter Snapshot die Lobby wiederbeleben.
 */
import { lobbyCodeSchema } from "@quizmaster/shared";
import {
  documentIdSchema,
  type LobbyDoc,
  lobbyDocSchema,
  ownerGuestIdSchema,
  RETENTION,
} from "@quizmaster/shared/documents";
import type { ClientSession, Collection, Filter } from "mongodb";
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

/** Ersetzbar ist nur ein älterer/gleicher Stand – und ein aktiver Snapshot ersetzt nie eine geschlossene Lobby. */
function snapshotFilter(doc: LobbyDoc): Filter<LobbyDoc> {
  return doc.active ? { _id: doc._id, active: true, rev: { $lte: doc.rev } } : { _id: doc._id, rev: { $lte: doc.rev } };
}

/**
 * Schreibt einen (bereits validierten) Snapshot mit Guard – auch innerhalb einer Transaktion nutzbar:
 * kein Upsert (dessen E11000 bei neuerem Stand würde die Transaktion abbrechen), sondern Ersetzen des
 * passenden Dokuments bzw. Anlegen, wenn es noch keins gibt. `stale`: in der DB steht ein neuerer oder
 * geschlossener Stand, es wurde nichts geschrieben. Fehler (auch E11000 beim Anlegen) werden weitergereicht.
 */
export async function writeLobbySnapshot(
  lobbies: Collection<LobbyDoc>,
  doc: LobbyDoc,
  session?: ClientSession,
): Promise<"saved" | "stale"> {
  const replaced = await lobbies.replaceOne(snapshotFilter(doc), doc, { session });
  if (replaced.matchedCount === 1) return "saved";
  const existing = await lobbies.findOne({ _id: doc._id }, { projection: { _id: 1 }, session });
  if (existing !== null) return "stale";
  await lobbies.insertOne(doc, { session });
  return "saved";
}

export interface LobbiesRepo {
  /** Neue Lobby; `code_taken`, wenn eine andere AKTIVE Lobby den Code hat. */
  insert(lobby: LobbyDoc): Promise<LobbyInsertResult>;
  /**
   * Snapshot schreiben (ersetzen oder anlegen); `stale`, wenn in der DB bereits ein neuerer `rev` steht
   * oder – bei einem aktiven Snapshot – die Lobby schon geschlossen ist.
   */
  save(lobby: LobbyDoc, session?: ClientSession): Promise<LobbySaveResult>;
  /** Code-Lookup (nutzt den partiellen Unique-Index). */
  findActiveByCode(code: string): Promise<LobbyDoc | null>;
  isCodeTaken(code: string): Promise<boolean>;
  findById(lobbyId: string): Promise<LobbyDoc | null>;
  /** Aktive gehostete Lobbys eines Gasts („max. 1 aktive Lobby pro Host“). */
  countActiveHostedBy(guestId: string): Promise<number>;
  /** Alle aktiven Lobbys (Wiederaufnahme nach Neustart). */
  listActive(): Promise<LobbyDoc[]>;
  /**
   * Aktive Lobby schließen → Code frei; Aufbewahrung bis `endedAt + 2 h`; `rev + 1`, damit kein später
   * Snapshot mit dem alten `rev` sie überschreibt. `false`: unbekannt oder bereits geschlossen.
   */
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
        return await writeLobbySnapshot(lobbies, doc, session);
      } catch (error) {
        // In einer Transaktion nie schlucken: der Server hat sie abgebrochen, der Aufrufer muss es sehen.
        if (session?.inTransaction()) throw error;
        // Parallel angelegt (zwischen Prüfung und Anlegen) → der andere Stand gilt.
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
        { _id: documentIdSchema.parse(lobbyId), active: true },
        {
          $set: { active: false, updatedAt: endedAt, expiresAt: endedLobbyExpiresAt(endedAt) },
          $inc: { rev: 1 },
        },
      );
      return result.matchedCount === 1;
    },
  };
}
