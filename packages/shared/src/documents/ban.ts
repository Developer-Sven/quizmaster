import { z } from "zod";
import { documentIdSchema } from "./lobby.ts";

export const BAN_KINDS = ["guest", "ip"] as const;
export type BanKind = (typeof BAN_KINDS)[number];

/** bans – Sperren für Gast oder IP-Schlüssel; ohne `expiresAt` dauerhaft (TTL-Index). */
export const banDocSchema = z.object({
  _id: documentIdSchema,
  kind: z.enum(BAN_KINDS),
  /** guestId oder ipKey (HMAC) – nie eine rohe IP. */
  value: z.string().min(1).max(128),
  reason: z.string().min(1).max(500),
  createdAt: z.date(),
  /** Fehlt = dauerhaft. */
  expiresAt: z.date().optional(),
});
export type BanDoc = z.output<typeof banDocSchema>;
