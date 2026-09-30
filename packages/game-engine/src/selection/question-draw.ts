/**
 * Fragenziehung (docs/04 §Fragenauswahl Schritt 5, docs/01 §Fragenauswahl) als reine Funktion:
 * - K Fragen der Kategorie, für alle in der Lobby ungesehen und nie doppelt im Spiel,
 * - Schwierigkeit nach Katalog-Mix gewichtet und je Zug möglichst gemischt: Stufen werden gewichtet ohne
 *   Zurücklegen gezogen (erst wenn alle verfügbaren Stufen dran waren, wiederholt sich eine),
 * - innerhalb einer Stufe werden noch nicht vertretene Themen bevorzugt,
 * - reichen ungesehene Fragen nicht: mit gesehenen auffüllen (älteste zuerst, markiert mit `seen: true`),
 * - Ergebnis aufsteigend nach Schwierigkeit (leicht → schwer).
 * Weniger als K Fragen kommen nur zurück, wenn die Kategorie insgesamt nicht mehr unbenutzte Fragen hat.
 */
import { DIFFICULTIES, type Difficulty } from "@quizmaster/shared";
import type { DifficultyMix } from "@quizmaster/shared/content";
import { pickOne, type Rng, shuffle, weightedIndex } from "../rng.ts";
import type { PoolQuestion, QuestionPool, SeenQuestions } from "./pool.ts";

export interface QuestionDrawInput {
  categoryId: string;
  /** K = Fragen pro Kategorie (Effect `loadQuestions.count`). */
  count: number;
  pool: QuestionPool;
  seen: SeenQuestions;
  /** Im Spiel bereits benutzte Fragen (Effect `loadQuestions.excludeQuestionIds`). */
  usedQuestionIds: Iterable<string>;
  /** `appConfig.catalog.difficultyMix`. */
  difficultyMix: DifficultyMix;
  rng: Rng;
}

export interface DrawnQuestion {
  id: string;
  difficulty: Difficulty;
  topic: string;
  /** true = bereits gesehen und nur zum Auffüllen gezogen (Shell vermerkt es im Log). */
  seen: boolean;
}

/** Gewicht einer Stufe laut Katalog-Mix. */
function mixWeight(mix: DifficultyMix, difficulty: Difficulty): number {
  return mix[`${difficulty}`];
}

/** Zieht bis zu `count` Fragen: Stufen gewichtet ohne Zurücklegen, neue Themen bevorzugt. */
function drawMixed(candidates: readonly PoolQuestion[], count: number, mix: DifficultyMix, rng: Rng): PoolQuestion[] {
  const buckets = new Map<Difficulty, PoolQuestion[]>();
  for (const question of candidates) {
    const bucket = buckets.get(question.difficulty);
    if (bucket) bucket.push(question);
    else buckets.set(question.difficulty, [question]);
  }
  const chosen: PoolQuestion[] = [];
  const topics = new Set<string>();
  let usedLevels = new Set<Difficulty>();
  while (chosen.length < count) {
    const available = DIFFICULTIES.filter((level) => (buckets.get(level)?.length ?? 0) > 0);
    if (available.length === 0) break;
    let levels = available.filter((level) => !usedLevels.has(level));
    if (levels.length === 0) {
      usedLevels = new Set();
      levels = available;
    }
    const level = levels[
      weightedIndex(
        levels.map((entry) => mixWeight(mix, entry)),
        rng,
      )
    ] as Difficulty;
    usedLevels.add(level);
    const bucket = buckets.get(level) ?? [];
    const freshTopic = bucket.filter((question) => !topics.has(question.topic));
    const pick = pickOne(freshTopic.length > 0 ? freshTopic : bucket, rng);
    bucket.splice(bucket.indexOf(pick), 1);
    topics.add(pick.topic);
    chosen.push(pick);
  }
  return chosen;
}

/** Zieht die Fragen eines Zuges (siehe Moduldoku). */
export function drawQuestions(input: QuestionDrawInput): DrawnQuestion[] {
  const { count, rng } = input;
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`count muss ≥ 1 sein (erhalten: ${count})`);
  const used = new Set(input.usedQuestionIds);
  const unique = new Map<string, PoolQuestion>();
  for (const question of input.pool.get(input.categoryId) ?? []) {
    if (!used.has(question.id) && !unique.has(question.id)) unique.set(question.id, question);
  }
  const candidates = [...unique.values()];
  const unseen = candidates.filter((question) => !input.seen.has(question.id));
  const picked = drawMixed(unseen, count, input.difficultyMix, rng).map((question) => ({ question, seen: false }));
  if (picked.length < count) {
    // Auffüllen mit gesehenen Fragen: am längsten nicht gesehene zuerst, Gleichstand zufällig.
    const refill = shuffle(
      candidates.filter((question) => input.seen.has(question.id)),
      rng,
    )
      .sort((a, b) => (input.seen.get(b.id) ?? 0) - (input.seen.get(a.id) ?? 0))
      .slice(0, count - picked.length);
    picked.push(...refill.map((question) => ({ question, seen: true })));
  }
  return picked
    .sort((a, b) => a.question.difficulty - b.question.difficulty)
    .map(({ question, seen }) => ({ id: question.id, difficulty: question.difficulty, topic: question.topic, seen }));
}
