/**
 * bans (docs/04, docs/06): Sperren für Gast oder IP-Schlüssel (HMAC, nie rohe IPs). Eindeutig je
 * `kind + value` (Unique-Index); ohne `expiresAt` dauerhaft. Weil der TTL-Monitor nur etwa minütlich
 * löscht, prüfen Abfragen das Ablaufdatum selbst.
 *
 * `upsert` ist EIN atomares Update mit Pipeline (kein „lesen, dann schreiben“): Eine Sperre wird nur
 * verlängert, nie verkürzt – auch wenn Realtime (Verstoß-Eskalation) und die Admin-CLI gleichzeitig sperren.
 */
import { randomUUID } from "node:crypto";
import { BAN_KINDS, type BanDoc, type BanKind } from "@quizmaster/shared/documents";
import type { Collection, Document, Filter } from "mongodb";
import { z } from "zod";
import { USER_READ_MAX_TIME_MS } from "../client.ts";
import { isDuplicateKeyError } from "../errors.ts";
import { chunk, uniqueIds } from "./ids.ts";

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

/** Höchstzahl Einträge einer Liste aktiver Sperren (Admin-CLI). */
export const BAN_LIST_MAX = 500;
/** Größe der `$in`-Blöcke beim Abgleich verbundener Gäste/IP-Schlüssel. */
export const BAN_LOOKUP_CHUNK = 1_000;

/** Filter „noch gültig“: dauerhaft oder Ablauf in der Zukunft. */
function activeAt(now: Date): Filter<BanDoc> {
  return { $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] };
}

/** Ergebnis eines Upserts: die gültige Sperre danach und ob sie neu bzw. länger geworden ist. */
export interface BanUpsertResult {
  ban: BanDoc;
  /** `false`: eine gleich lange, längere oder dauerhafte Sperre bestand schon (nichts verkürzt). */
  extended: boolean;
}

export interface BansRepo {
  /**
   * Sperre anlegen oder verlängern (atomar je `kind + value`): Bestehende aktive Sperren werden nie verkürzt –
   * dauerhaft bleibt dauerhaft, ein späteres Ablaufdatum bleibt. Abgelaufene Einträge zählen als neu.
   */
  upsert(ban: NewBan, now: Date): Promise<BanDoc>;
  /** Wie `upsert`, liefert zusätzlich, ob die Sperre neu bzw. länger wurde. */
  extend(ban: NewBan, now: Date): Promise<BanUpsertResult>;
  /** Aktive Sperre für genau einen Schlüssel. */
  findActive(kind: BanKind, value: string, now: Date): Promise<BanDoc | null>;
  /** Aktive Sperre für Gast ODER IP-Schlüssel (Handshake/Ticket-Prüfung). */
  findActiveFor(subject: { guestId?: string; ipKey?: string }, now: Date): Promise<BanDoc | null>;
  /** Alle aktiven Sperren unter den angegebenen Gästen und IP-Schlüsseln (Abgleich verbundener Sockets). */
  findActiveAmong(subjects: { guestIds: readonly string[]; ipKeys: readonly string[] }, now: Date): Promise<BanDoc[]>;
  /** Aktive Sperren, neueste zuerst (höchstens `limit`, Standard und Obergrenze `BAN_LIST_MAX`), mit Gesamtzahl. */
  listActive(now: Date, options?: { limit?: number }): Promise<{ bans: BanDoc[]; total: number }>;
  remove(kind: BanKind, value: string): Promise<boolean>;
}

/**
 * Update-Pipeline des Upserts. Eine `$set`-Stufe wertet alle Ausdrücke gegen den Stand VOR dem Update aus;
 * beim Einfügen fehlt `_id` (nur `kind`/`value` aus dem Filter sind gesetzt).
 */
function extendPipeline(ban: NewBan, now: Date, newId: string): Document[] {
  const exists = { $ne: [{ $type: "$_id" }, "missing"] };
  const noExpiry = { $eq: [{ $type: "$expiresAt" }, "missing"] };
  const permanentActive = { $and: [exists, noExpiry] };
  const active = { $and: [exists, { $or: [noExpiry, { $gt: ["$expiresAt", now] }] }] };
  const base = {
    _id: { $ifNull: ["$_id", newId] },
    createdAt: { $cond: [active, "$createdAt", now] },
  };
  if (ban.expiresAt === undefined) {
    return [
      {
        $set: {
          ...base,
          // Schon dauerhaft gesperrt: Grund bleibt (idempotent); sonst wird die Sperre jetzt dauerhaft.
          reason: { $cond: [permanentActive, "$reason", ban.reason] },
          expiresAt: "$$REMOVE",
        },
      },
    ];
  }
  // Neue befristete Sperre gewinnt nur gegen „keine/abgelaufene“ oder eine früher ablaufende Sperre.
  const takeNew = {
    $or: [{ $not: [active] }, { $and: [{ $not: [permanentActive] }, { $lt: ["$expiresAt", ban.expiresAt] }] }],
  };
  return [
    {
      $set: {
        ...base,
        reason: { $cond: [takeNew, ban.reason, "$reason"] },
        expiresAt: { $cond: [permanentActive, "$$REMOVE", { $cond: [takeNew, ban.expiresAt, "$expiresAt"] }] },
      },
    },
  ];
}

function isExtended(before: BanDoc | null, after: BanDoc, now: Date): boolean {
  const wasActive = before !== null && (before.expiresAt === undefined || before.expiresAt.getTime() > now.getTime());
  if (!wasActive || before === null) return true;
  if (before.expiresAt === undefined) return false;
  return after.expiresAt === undefined || after.expiresAt.getTime() > before.expiresAt.getTime();
}

export function createBansRepo(bans: Collection<BanDoc>): BansRepo {
  const extend = async (ban: NewBan, now: Date): Promise<BanUpsertResult> => {
    const parsed = newBanSchema.parse(ban);
    const run = () =>
      bans.findOneAndUpdate({ kind: parsed.kind, value: parsed.value }, extendPipeline(parsed, now, randomUUID()), {
        upsert: true,
        returnDocument: "before",
        includeResultMetadata: false,
      });
    let before: BanDoc | null;
    try {
      before = await run();
    } catch (error) {
      // Zwei gleichzeitige Erst-Sperren: der Unique-Index lässt eine scheitern – dann ist es ein Update.
      if (!isDuplicateKeyError(error)) throw error;
      before = await run();
    }
    const after = await bans.findOne({ kind: parsed.kind, value: parsed.value });
    if (after === null) throw new Error("Ban-Upsert lieferte kein Dokument");
    return { ban: after, extended: isExtended(before, after, now) };
  };

  return {
    async upsert(ban, now) {
      return (await extend(ban, now)).ban;
    },

    extend,

    async findActive(kind, value, now) {
      return bans.findOne(
        { kind: banKindSchema.parse(kind), value: banValueSchema.parse(value), ...activeAt(now) },
        { maxTimeMS: USER_READ_MAX_TIME_MS },
      );
    },

    async findActiveFor(subject, now) {
      const keys: Filter<BanDoc>[] = [];
      if (subject.guestId !== undefined) keys.push({ kind: "guest", value: banValueSchema.parse(subject.guestId) });
      if (subject.ipKey !== undefined) keys.push({ kind: "ip", value: banValueSchema.parse(subject.ipKey) });
      if (keys.length === 0) return null;
      return bans.findOne({ $and: [{ $or: keys }, activeAt(now)] }, { maxTimeMS: USER_READ_MAX_TIME_MS });
    },

    async findActiveAmong(subjects, now) {
      const guestIds = uniqueIds(subjects.guestIds.map((id) => banValueSchema.parse(id)));
      const ipKeys = uniqueIds(subjects.ipKeys.map((key) => banValueSchema.parse(key)));
      const found: BanDoc[] = [];
      const lookups: Array<{ kind: BanKind; values: string[] }> = [
        ...chunk(guestIds, BAN_LOOKUP_CHUNK).map((values) => ({ kind: "guest" as const, values })),
        ...chunk(ipKeys, BAN_LOOKUP_CHUNK).map((values) => ({ kind: "ip" as const, values })),
      ];
      for (const lookup of lookups) {
        const docs = await bans
          .find(
            { $and: [{ kind: lookup.kind, value: { $in: lookup.values } }, activeAt(now)] },
            { maxTimeMS: USER_READ_MAX_TIME_MS },
          )
          .toArray();
        found.push(...docs);
      }
      return found;
    },

    async listActive(now, options = {}) {
      const limit = Math.min(BAN_LIST_MAX, Math.max(1, Math.trunc(options.limit ?? BAN_LIST_MAX)));
      const filter = activeAt(now);
      const [list, total] = await Promise.all([
        bans.find(filter, { maxTimeMS: USER_READ_MAX_TIME_MS }).sort({ createdAt: -1 }).limit(limit).toArray(),
        bans.countDocuments(filter, { maxTimeMS: USER_READ_MAX_TIME_MS }),
      ]);
      return { bans: list, total };
    },

    async remove(kind, value) {
      const result = await bans.deleteOne({ kind: banKindSchema.parse(kind), value: banValueSchema.parse(value) });
      return result.deletedCount === 1;
    },
  };
}
