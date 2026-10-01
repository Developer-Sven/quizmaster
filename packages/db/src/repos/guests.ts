/**
 * guests (docs/04): Gast anlegen (web `POST /api/session`), Aktivität erneuern (TTL 180 Tage ab
 * letzter Aktivität), gesehene Fragen laden (Spielstart) und Spielabschluss (`$push` + `$slice: -1000`,
 * Statistik `$inc`). Filter nur aus validierten Primitiven (docs/06 §MongoDB-Injection).
 */
import { guestIdSchema } from "@quizmaster/shared";
import { type GuestDoc, RECENT_QUESTION_IDS_MAX, RETENTION } from "@quizmaster/shared/documents";
import type { ClientSession, Collection, UpdateFilter } from "mongodb";
import { z } from "zod";
import { HOT_PATH_TIMEOUT_MS, USER_READ_MAX_TIME_MS } from "../client.ts";
import { questionIdListSchema } from "./ids.ts";

/** Gast ohne die (große) Liste gesehener Fragen. */
export type GuestProfile = Omit<GuestDoc, "recentQuestionIds">;

export const guestStatsDeltaSchema = z.strictObject({
  games: z.int().min(0).max(1),
  wins: z.int().min(0).max(1),
  draws: z.int().min(0).max(1),
  answers: z.int().min(0).max(10_000),
  correct: z.int().min(0).max(10_000),
});
export type GuestStatsDelta = z.output<typeof guestStatsDeltaSchema>;

export const guestGameResultSchema = z.strictObject({
  guestId: guestIdSchema,
  /** In diesem Spiel gezeigte Fragen (DB-IDs, Reihenfolge wie gespielt). */
  questionIds: questionIdListSchema,
  stats: guestStatsDeltaSchema,
});
export type GuestGameResult = z.output<typeof guestGameResultSchema>;

const nameSchema = z.string().min(1).max(64);

export function guestExpiresAt(lastSeenAt: Date): Date {
  return new Date(lastSeenAt.getTime() + RETENTION.guestMs);
}

/** Update für einen Gast nach Spielende (auch innerhalb der Abschluss-Transaktion genutzt). */
export function guestGameResultUpdate(result: GuestGameResult, now: Date): UpdateFilter<GuestDoc> {
  return {
    $push: { recentQuestionIds: { $each: result.questionIds, $slice: -RECENT_QUESTION_IDS_MAX } },
    $inc: {
      "stats.games": result.stats.games,
      "stats.wins": result.stats.wins,
      "stats.draws": result.stats.draws,
      "stats.answers": result.stats.answers,
      "stats.correct": result.stats.correct,
    },
    $set: { lastSeenAt: now, expiresAt: guestExpiresAt(now) },
  };
}

export interface GuestsRepo {
  /** Neuer Gast (guestId = `crypto.randomUUID()` vom Aufrufer). */
  create(guestId: string, now: Date, lastName?: string): Promise<GuestDoc>;
  /** Profil ohne `recentQuestionIds`; `null`, wenn unbekannt oder per TTL gelöscht. */
  findProfile(guestId: string): Promise<GuestProfile | null>;
  /** Aktivität erneuern (verlängert die TTL); `false`, wenn der Gast nicht mehr existiert. */
  touch(guestId: string, now: Date, lastName?: string): Promise<boolean>;
  /** Gesehene Fragen aller Mitspielenden (Spielstart); fehlende Gäste fehlen in der Map. */
  loadRecentQuestionIds(guestIds: readonly string[]): Promise<Map<string, string[]>>;
  /** Spielabschluss für einen Gast (außerhalb der Transaktion, z. B. für Tests/Werkzeuge). */
  recordGameResult(result: GuestGameResult, now: Date, session?: ClientSession): Promise<boolean>;
}

export function createGuestsRepo(guests: Collection<GuestDoc>): GuestsRepo {
  return {
    async create(guestId, now, lastName) {
      const doc: GuestDoc = {
        _id: guestIdSchema.parse(guestId),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: guestExpiresAt(now),
        ...(lastName === undefined ? {} : { lastName: nameSchema.parse(lastName) }),
        stats: { games: 0, wins: 0, draws: 0, answers: 0, correct: 0 },
        recentQuestionIds: [],
      };
      await guests.insertOne(doc, { timeoutMS: HOT_PATH_TIMEOUT_MS });
      return doc;
    },

    async findProfile(guestId) {
      return guests.findOne<GuestProfile>(
        { _id: guestIdSchema.parse(guestId) },
        { projection: { recentQuestionIds: 0 }, maxTimeMS: USER_READ_MAX_TIME_MS },
      );
    },

    async touch(guestId, now, lastName) {
      const set: Partial<GuestDoc> = { lastSeenAt: now, expiresAt: guestExpiresAt(now) };
      if (lastName !== undefined) set.lastName = nameSchema.parse(lastName);
      const result = await guests.updateOne(
        { _id: guestIdSchema.parse(guestId) },
        { $set: set },
        { timeoutMS: HOT_PATH_TIMEOUT_MS },
      );
      return result.matchedCount === 1;
    },

    async loadRecentQuestionIds(guestIds) {
      const ids = [...new Set(guestIds.map((id) => guestIdSchema.parse(id)))];
      const result = new Map<string, string[]>();
      if (ids.length === 0) return result;
      const cursor = guests.find<Pick<GuestDoc, "_id" | "recentQuestionIds">>(
        { _id: { $in: ids } },
        { projection: { recentQuestionIds: 1 }, maxTimeMS: USER_READ_MAX_TIME_MS },
      );
      for await (const doc of cursor) result.set(doc._id, doc.recentQuestionIds);
      return result;
    },

    async recordGameResult(result, now, session) {
      const parsed = guestGameResultSchema.parse(result);
      const update = await guests.updateOne({ _id: parsed.guestId }, guestGameResultUpdate(parsed, now), { session });
      return update.matchedCount === 1;
    },
  };
}
