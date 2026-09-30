import { z } from "zod";
import { guestIdSchema } from "../auth.ts";
import { QUESTION_ID_REGEX } from "../content/questions.ts";
import { NAME_INPUT_MAX_LENGTH } from "../names.ts";
import { RECENT_QUESTION_IDS_MAX } from "./collections.ts";

const count = z.int().min(0);

/** guests – Gast-Identität, Profil, Statistik, zuletzt gesehene Fragen (TTL 180 Tage). */
export const guestDocSchema = z.object({
  /** guestId = `crypto.randomUUID()` – GEHEIM, nie an andere Clients. */
  _id: guestIdSchema,
  createdAt: z.date(),
  lastSeenAt: z.date(),
  /** lastSeenAt + 180 Tage (TTL). */
  expiresAt: z.date(),
  /** Zuletzt verwendeter Name (Vorbelegung). */
  lastName: z.string().min(1).max(NAME_INPUT_MAX_LENGTH).optional(),
  stats: z.object({ games: count, wins: count, draws: count, answers: count, correct: count }),
  /** Neueste hinten, max. 1.000 (DB-Fragen-IDs). */
  recentQuestionIds: z.array(z.string().regex(QUESTION_ID_REGEX)).max(RECENT_QUESTION_IDS_MAX),
});
export type GuestDoc = z.output<typeof guestDocSchema>;
