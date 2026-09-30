/**
 * questionReports (docs/04, docs/08 §5): Meldungen aus „Fragen ansehen“ (TTL 365 Tage), Prüf-Queue
 * (Index `status + createdAt`) und Zählung für die Schutzautomatik – verschiedene Gäste je Frage in
 * einem Zeitfenster (Index `questionId + createdAt`).
 */
import { randomUUID } from "node:crypto";
import { lobbyCodeSchema, REPORT_REASONS, type ReportReason } from "@quizmaster/shared";
import {
  documentIdSchema,
  ownerGuestIdSchema,
  type QuestionReportDoc,
  REPORT_STATUSES,
  RETENTION,
  type ReportStatus,
} from "@quizmaster/shared/documents";
import type { Collection } from "mongodb";
import { z } from "zod";
import { chunk, questionIdSchema, uniqueIds } from "./ids.ts";

/** Gründe, die für die Schutzautomatik zählen (docs/08 §5). */
export const AUTO_RETIRE_REPORT_REASONS: readonly ReportReason[] = ["falsch", "veraltet", "mehrdeutig"];

export const newReportSchema = z.strictObject({
  questionId: questionIdSchema,
  reason: z.enum(REPORT_REASONS),
  guestId: ownerGuestIdSchema,
  lobbyCode: lobbyCodeSchema.nullable(),
});
export type NewReport = z.output<typeof newReportSchema>;

/** Höchstzahl je Queue-Abfrage. */
export const REPORT_QUEUE_MAX = 200;

export interface ReportsRepo {
  create(report: NewReport, now: Date): Promise<QuestionReportDoc>;
  /** Offene Meldungen, neueste zuerst (Prüf-Queue). */
  listOpen(limit?: number): Promise<QuestionReportDoc[]>;
  setStatus(reportId: string, status: ReportStatus): Promise<boolean>;
  /** Anzahl verschiedener Gäste mit Meldungen der Gründe `reasons` seit `since`. */
  countDistinctReporters(questionId: string, since: Date, reasons?: readonly ReportReason[]): Promise<number>;
  /** Welche der Fragen hat dieser Gast bereits gemeldet? (`myReported` im Rückblick) */
  findReportedQuestionIds(guestId: string, questionIds: readonly string[]): Promise<Set<string>>;
}

export function createReportsRepo(reports: Collection<QuestionReportDoc>): ReportsRepo {
  return {
    async create(report, now) {
      const parsed = newReportSchema.parse(report);
      const doc: QuestionReportDoc = {
        _id: randomUUID(),
        ...parsed,
        status: "open",
        createdAt: now,
        expiresAt: new Date(now.getTime() + RETENTION.questionReportMs),
      };
      await reports.insertOne(doc);
      return doc;
    },

    async listOpen(limit = 50) {
      const capped = Math.max(1, Math.min(REPORT_QUEUE_MAX, Math.trunc(limit)));
      return reports.find({ status: "open" }).sort({ createdAt: -1 }).limit(capped).toArray();
    },

    async setStatus(reportId, status) {
      const result = await reports.updateOne(
        { _id: documentIdSchema.parse(reportId) },
        { $set: { status: z.enum(REPORT_STATUSES).parse(status) } },
      );
      return result.matchedCount === 1;
    },

    async countDistinctReporters(questionId, since, reasons = AUTO_RETIRE_REPORT_REASONS) {
      const reasonList = z.array(z.enum(REPORT_REASONS)).parse(reasons);
      const [row] = await reports
        .aggregate<{ reporters: number }>([
          {
            $match: {
              questionId: questionIdSchema.parse(questionId),
              createdAt: { $gte: since },
              reason: { $in: reasonList },
            },
          },
          { $group: { _id: "$guestId" } },
          { $count: "reporters" },
        ])
        .toArray();
      return row?.reporters ?? 0;
    },

    async findReportedQuestionIds(guestId, questionIds) {
      const guest = ownerGuestIdSchema.parse(guestId);
      const ids = uniqueIds(questionIds.map((id) => questionIdSchema.parse(id)));
      const reported = new Set<string>();
      for (const part of chunk(ids, 500)) {
        const rows = await reports
          .find<Pick<QuestionReportDoc, "questionId">>(
            { questionId: { $in: part }, guestId: guest },
            { projection: { _id: 0, questionId: 1 } },
          )
          .toArray();
        for (const row of rows) reported.add(row.questionId);
      }
      return reported;
    },
  };
}
