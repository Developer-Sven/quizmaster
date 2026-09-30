import { z } from "zod";
import { RATING_VALUES, REPORT_REASONS } from "../constants.ts";
import { QUESTION_ID_REGEX } from "../content/questions.ts";
import { lobbyCodeSchema } from "../primitives.ts";
import { documentIdSchema, ownerGuestIdSchema } from "./lobby.ts";

const questionIdSchema = z.string().regex(QUESTION_ID_REGEX);

export const REPORT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** questionReports – Meldungen aus „Fragen ansehen“ (TTL 365 Tage). */
export const questionReportDocSchema = z.object({
  _id: documentIdSchema,
  /** DB-ID der Frage. */
  questionId: questionIdSchema,
  reason: z.enum(REPORT_REASONS),
  /** Nur für Missbrauchserkennung, nie anzeigen. */
  guestId: ownerGuestIdSchema,
  lobbyCode: lobbyCodeSchema.nullable(),
  status: z.enum(REPORT_STATUSES),
  createdAt: z.date(),
  /** createdAt + 365 Tage (TTL). */
  expiresAt: z.date(),
});
export type QuestionReportDoc = z.output<typeof questionReportDocSchema>;

/** `_id` einer Bewertung: `${questionId}:${guestId}` → eine Bewertung pro Gast und Frage. */
export function questionRatingId(questionId: string, guestId: string): string {
  return `${questionId}:${guestId}`;
}

/** questionRatings – Daumen hoch/runter je Gast und Frage (TTL 365 Tage). */
export const questionRatingDocSchema = z
  .object({
    _id: z.string().min(1).max(160),
    questionId: questionIdSchema,
    value: z.literal(RATING_VALUES),
    updatedAt: z.date(),
    /** updatedAt + 365 Tage (TTL). */
    expiresAt: z.date(),
  })
  .refine((doc) => doc._id.startsWith(`${doc.questionId}:`), {
    message: "_id muss <questionId>:<guestId> sein",
    path: ["_id"],
  });
export type QuestionRatingDoc = z.output<typeof questionRatingDocSchema>;
