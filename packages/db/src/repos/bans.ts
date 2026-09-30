/**
 * bans (docs/04, docs/06): Sperren für Gast oder IP-Schlüssel (HMAC, nie rohe IPs). Eindeutig je
 * `kind + value` (Unique-Index); ohne `expiresAt` dauerhaft. Weil der TTL-Monitor nur etwa minütlich
 * löscht, prüfen Abfragen das Ablaufdatum selbst.
 */
import { randomUUID } from "node:crypto";
import { BAN_KINDS, type BanDoc, type BanKind } from "@quizmaster/shared/documents";
import type { Collection, Filter } from "mongodb";
import { z } from "zod";

const banValueSchema = z.string().min(1).max(128);
const banKindSchema = z.enum(BAN_KINDS);

export const newBanSchema = z.strictObject({
  kind: banKindSchema,
  value: banValueSchema,
  reason: z.string().min(1).max(500),
  /** Fehlt = dauerhaft. */
  expiresAt: z.date().optional(),
});
export type NewBan = z.output<typeof newBanSchema>;

/** Filter „noch gültig“: dauerhaft oder Ablauf in der Zukunft. */
function activeAt(now: Date): Filter<BanDoc> {
  return { $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] };
}

export interface BansRepo {
  /** Sperre anlegen oder verlängern/ändern (Upsert je `kind + value`). */
  upsert(ban: NewBan, now: Date): Promise<BanDoc>;
  /** Aktive Sperre für genau einen Schlüssel. */
  findActive(kind: BanKind, value: string, now: Date): Promise<BanDoc | null>;
  /** Aktive Sperre für Gast ODER IP-Schlüssel (Handshake/Ticket-Prüfung). */
  findActiveFor(subject: { guestId?: string; ipKey?: string }, now: Date): Promise<BanDoc | null>;
  remove(kind: BanKind, value: string): Promise<boolean>;
}

export function createBansRepo(bans: Collection<BanDoc>): BansRepo {
  return {
    async upsert(ban, now) {
      const parsed = newBanSchema.parse(ban);
      const update =
        parsed.expiresAt === undefined
          ? { $set: { reason: parsed.reason }, $unset: { expiresAt: "" as const } }
          : { $set: { reason: parsed.reason, expiresAt: parsed.expiresAt } };
      const doc = await bans.findOneAndUpdate(
        { kind: parsed.kind, value: parsed.value },
        { ...update, $setOnInsert: { _id: randomUUID(), createdAt: now } },
        { upsert: true, returnDocument: "after" },
      );
      if (doc === null) throw new Error("Ban-Upsert lieferte kein Dokument");
      return doc;
    },

    async findActive(kind, value, now) {
      return bans.findOne({ kind: banKindSchema.parse(kind), value: banValueSchema.parse(value), ...activeAt(now) });
    },

    async findActiveFor(subject, now) {
      const keys: Filter<BanDoc>[] = [];
      if (subject.guestId !== undefined) keys.push({ kind: "guest", value: banValueSchema.parse(subject.guestId) });
      if (subject.ipKey !== undefined) keys.push({ kind: "ip", value: banValueSchema.parse(subject.ipKey) });
      if (keys.length === 0) return null;
      return bans.findOne({ $and: [{ $or: keys }, activeAt(now)] });
    },

    async remove(kind, value) {
      const result = await bans.deleteOne({ kind: banKindSchema.parse(kind), value: banValueSchema.parse(value) });
      return result.deletedCount === 1;
    },
  };
}
