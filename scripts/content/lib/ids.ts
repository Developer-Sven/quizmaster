/**
 * `content:ids`: neue, eindeutige Fragen-IDs `<Kürzel>-<8 Zeichen a–z0–9>` (docs/08 §3). Zufall aus
 * `crypto.randomInt`; bereits vergebene IDs des Katalogs werden ausgeschlossen (36⁸ ≈ 2,8 Billionen).
 */
import { randomInt } from "node:crypto";
import { CATEGORY_ID_PREFIXES, type CategorySlug, QUESTION_ID_REGEX } from "@quizmaster/shared/content";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const MAX_IDS_PER_CALL = 10_000;

export function generateQuestionIds(
  slug: CategorySlug,
  count: number,
  taken: ReadonlySet<string>,
  random: (max: number) => number = randomInt,
): string[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_IDS_PER_CALL) {
    throw new RangeError(`Anzahl muss zwischen 1 und ${MAX_IDS_PER_CALL} liegen`);
  }
  const prefix = CATEGORY_ID_PREFIXES[slug];
  const result: string[] = [];
  const used = new Set(taken);
  while (result.length < count) {
    let suffix = "";
    for (let index = 0; index < 8; index++) suffix += ALPHABET[random(ALPHABET.length)];
    const id = `${prefix}-${suffix}`;
    if (used.has(id) || !QUESTION_ID_REGEX.test(id)) continue;
    used.add(id);
    result.push(id);
  }
  return result;
}
