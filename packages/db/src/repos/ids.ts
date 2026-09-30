/** Validierte ID-Listen für `$in`-Filter (nie ungeprüfte Werte aus Requests in Queries). */

import { MAX_QUESTIONS_PER_GAME } from "@quizmaster/shared";
import { QUESTION_ID_REGEX } from "@quizmaster/shared/content";
import { z } from "zod";

export const questionIdSchema = z.string().regex(QUESTION_ID_REGEX);

/** Fragen-IDs eines Spiels (höchstens so viele, wie ein Spiel haben kann). */
export const questionIdListSchema = z.array(questionIdSchema).max(MAX_QUESTIONS_PER_GAME);

/** Entfernt Duplikate unter Beibehaltung der Reihenfolge. */
export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/** Teilt eine Liste in Blöcke (große `$in`-Listen und Bulk-Writes stückeln). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size muss ≥ 1 sein");
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}
