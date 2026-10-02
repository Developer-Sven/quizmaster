/**
 * Fragenziehung (docs/04 §Fragenauswahl Schritt 5, docs/01 §Fragenauswahl, ADR-055) als reine Funktion:
 * - K Fragen der Kategorie, für alle in der Lobby ungesehen und nie doppelt im Spiel, nur aus dem
 *   Schwierigkeitsbereich „von–bis“,
 * - Stufen nach der Regel des Zuges: pro Frage aufsteigend (gleichmäßig über den Bereich, 1–3 bei 6 Fragen:
 *   1, 1, 2, 2, 3, 3), pro Frage zufällig (gewichtet nach Katalog-Mix, Reihenfolge zufällig) oder pro Kategorie
 *   (alle Fragen eine Stufe – aufsteigend von Zug zu Zug bzw. zufällig, gewichtet nach Katalog-Mix),
 * - fehlt eine Stufe, kommt die nächstgelegene (gleich weit: zufällig),
 * - innerhalb einer Stufe werden noch nicht vertretene Themen bevorzugt,
 * - reichen ungesehene Fragen nicht: mit gesehenen auffüllen (älteste zuerst, markiert mit `seen: true`),
 * - Ergebnis aufsteigend nach Schwierigkeit (leicht → schwer) – außer „pro Frage, zufällig“.
 * Weniger als K Fragen kommen nur zurück, wenn die Kategorie im Bereich nicht mehr unbenutzte Fragen hat.
 */
import {
  DIFFICULTIES,
  type Difficulty,
  type DifficultyRule,
  difficultyRange,
  spreadDifficulties,
  turnDifficulty,
} from "@quizmaster/shared";
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
  /** `appConfig.catalog.difficultyMix` – Gewichte der zufälligen Stufen. */
  difficultyMix: DifficultyMix;
  /** Schwierigkeit des Zuges (Effect `loadQuestions.difficulty`); ohne: alle Stufen, pro Frage aufsteigend. */
  difficulty?: DifficultyRule;
  rng: Rng;
}

export interface DrawnQuestion {
  id: string;
  difficulty: Difficulty;
  topic: string;
  /** true = bereits gesehen und nur zum Auffüllen gezogen (Shell vermerkt es im Log). */
  seen: boolean;
}

/** Alle Stufen, pro Frage aufsteigend (Standard der Lobby-Einstellungen). */
const ALL_LEVELS: DifficultyRule = {
  min: 1,
  max: 5,
  basis: "question",
  order: "ascending",
  turnNumber: 1,
  turns: 1,
};

/** Zufällige Stufe aus `levels`, gewichtet nach Katalog-Mix (alle Gewichte 0: gleichverteilt). */
function weightedLevel(levels: readonly Difficulty[], mix: DifficultyMix, rng: Rng): Difficulty | undefined {
  if (levels.length === 0) return undefined;
  return levels[
    weightedIndex(
      levels.map((level) => mix[`${level}`]),
      rng,
    )
  ];
}

/** Geplante Stufe je Frage – `null`: pro Frage zufällig (erst beim Ziehen, aus den noch vorhandenen Stufen). */
function plannedLevels(rule: DifficultyRule, count: number, mix: DifficultyMix, rng: Rng): Difficulty[] | null {
  if (rule.basis === "category") {
    const level =
      rule.order === "ascending"
        ? turnDifficulty(rule.min, rule.max, rule.turnNumber, rule.turns)
        : (weightedLevel(difficultyRange(rule.min, rule.max), mix, rng) ?? rule.min);
    return Array.from({ length: count }, () => level);
  }
  return rule.order === "ascending" ? spreadDifficulties(rule.min, rule.max, count) : null;
}

/** Nächste Stufe mit Fragen zu `wanted`; gleich weit entfernte zufällig. */
function nearestLevel(wanted: Difficulty, buckets: ReadonlyMap<Difficulty, PoolQuestion[]>, rng: Rng) {
  for (let distance = 0; distance < DIFFICULTIES.length; distance++) {
    const options = DIFFICULTIES.filter(
      (level) => Math.abs(level - wanted) === distance && (buckets.get(level)?.length ?? 0) > 0,
    );
    if (options.length > 0) return pickOne(options, rng);
  }
  return undefined;
}

/** Zieht bis zu `count` Fragen nach den geplanten Stufen; neue Themen bevorzugt. */
function drawLevels(
  candidates: readonly PoolQuestion[],
  count: number,
  planned: readonly Difficulty[] | null,
  mix: DifficultyMix,
  rng: Rng,
): PoolQuestion[] {
  const buckets = new Map<Difficulty, PoolQuestion[]>();
  for (const question of candidates) {
    const bucket = buckets.get(question.difficulty);
    if (bucket) bucket.push(question);
    else buckets.set(question.difficulty, [question]);
  }
  const chosen: PoolQuestion[] = [];
  const topics = new Set<string>();
  for (let index = 0; index < count; index++) {
    const available = DIFFICULTIES.filter((level) => (buckets.get(level)?.length ?? 0) > 0);
    const wanted = planned?.[index] ?? weightedLevel(available, mix, rng);
    const level = wanted === undefined ? undefined : nearestLevel(wanted, buckets, rng);
    if (level === undefined) break;
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
  const rule = input.difficulty ?? ALL_LEVELS;
  const used = new Set(input.usedQuestionIds);
  const unique = new Map<string, PoolQuestion>();
  for (const question of input.pool.get(input.categoryId) ?? []) {
    if (question.difficulty < rule.min || question.difficulty > rule.max) continue;
    if (!used.has(question.id) && !unique.has(question.id)) unique.set(question.id, question);
  }
  const candidates = [...unique.values()];
  const unseen = candidates.filter((question) => !input.seen.has(question.id));
  const planned = plannedLevels(rule, count, input.difficultyMix, rng);
  const picked = drawLevels(unseen, count, planned, input.difficultyMix, rng).map((question) => ({
    question,
    seen: false,
  }));
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
  const ordered =
    rule.basis === "question" && rule.order === "random"
      ? shuffle(picked, rng)
      : picked.sort((a, b) => a.question.difficulty - b.question.difficulty);
  return ordered.map(({ question, seen }) => ({
    id: question.id,
    difficulty: question.difficulty,
    topic: question.topic,
    seen,
  }));
}
