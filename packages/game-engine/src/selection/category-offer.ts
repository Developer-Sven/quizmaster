/**
 * Kategorieangebot (docs/04 §Fragenauswahl Schritt 4, docs/01 §Kategoriewahl) als reine Funktion:
 * 1. Kandidaten = spielbare Kategorien mit ≥ K ungesehenen Fragen (für alle in der Lobby ungesehen und
 *    im Spiel unbenutzt), nie die Kategorie des letzten Zuges.
 * 2. Zuerst die in diesem Spiel noch nicht gespielten: daraus 3 zufällig (gleichverteilt).
 * 3. Weniger als 3: mit bereits gespielten auffüllen – am längsten nicht gespielte zuerst, Gleichstand zufällig.
 * 4. Reicht auch das nicht: Kategorien mit weniger als K ungesehenen Fragen zulassen (Schritt 5 füllt auf),
 *    in derselben Rangfolge; Kategorien ganz ohne unbenutzte Frage nie.
 * Die drei gewählten Kategorien werden zufällig angeordnet. Sind es keine 3, kommt `null` zurück
 * (Shell: `LOAD_FAILED`) – die Kategorie des letzten Zuges wird auch dann nie angeboten.
 * 5. Auswahl des Hosts (`turn.categoryIds`, ADR-048): nur diese Kategorien; reicht sie nicht für 3 ohne die des
 *    letzten Zuges, ist diese dabei, und es dürfen 1–2 Optionen sein (genau 1 = feste Kategorie).
 * 6. Schwierigkeitsbereich (`turn.difficulty`, ADR-055): gezählt werden nur Fragen darin.
 */
import type { CategoryOption } from "@quizmaster/shared";
import type { TurnRef } from "../effects.ts";
import { type Rng, shuffle } from "../rng.ts";
import type { QuestionPool, SeenQuestions } from "./pool.ts";

export interface CategoryOfferInput {
  /** Spielbare Kategorien (`categories.playable`) mit Anzeigedaten. */
  categories: readonly CategoryOption[];
  pool: QuestionPool;
  seen: SeenQuestions;
  /** Aus dem Effect `offerCategories` (`categoryIds`: Auswahl des Hosts, `null`/fehlt = alle – ADR-048). */
  turn: Pick<TurnRef, "questionsPerTurn" | "playedCategoryIds" | "usedQuestionIds"> & {
    categoryIds?: readonly string[] | null;
    difficulty?: TurnRef["difficulty"];
  };
  rng: Rng;
}

/** 3 Optionen – bei einer Auswahl des Hosts (ADR-048) auch 1–2. */
export type CategoryOffer = CategoryOption[];

interface Candidate {
  option: CategoryOption;
  /** Für alle ungesehen und im Spiel unbenutzt. */
  unseen: number;
  /** Im Spiel unbenutzt (gesehen oder nicht). */
  unused: number;
  /** Index des letzten Zuges mit dieser Kategorie; `undefined` = noch nicht gespielt. */
  lastPlayed: number | undefined;
}

/** Ungespielte zufällig zuerst, dann gespielte – am längsten nicht gespielte zuerst (Gleichstand zufällig). */
function rank(candidates: readonly Candidate[], rng: Rng): Candidate[] {
  const unplayed = shuffle(
    candidates.filter((candidate) => candidate.lastPlayed === undefined),
    rng,
  );
  const played = shuffle(
    candidates.filter((candidate) => candidate.lastPlayed !== undefined),
    rng,
  ).sort((a, b) => (a.lastPlayed ?? 0) - (b.lastPlayed ?? 0));
  return [...unplayed, ...played];
}

/** Liegt die Stufe im Bereich des Zuges (ohne Bereich: immer)? */
function inDifficultyRange(level: number, range: TurnRef["difficulty"] | undefined): boolean {
  return range === undefined || (level >= range.min && level <= range.max);
}

/** Kandidaten aus `categories` – ohne die des letzten Zuges, wenn `excludeLast`. */
function candidatesOf(input: CategoryOfferInput, categories: readonly CategoryOption[], excludeLast: boolean) {
  const { turn } = input;
  const used = new Set(turn.usedQuestionIds);
  const lastCategory = turn.playedCategoryIds.at(-1);
  const lastPlayedAt = new Map<string, number>();
  turn.playedCategoryIds.forEach((categoryId, index) => {
    lastPlayedAt.set(categoryId, index);
  });
  const candidates: Candidate[] = [];
  const ids = new Set<string>();
  for (const option of categories) {
    if (ids.has(option.id) || (excludeLast && option.id === lastCategory)) continue;
    ids.add(option.id);
    let unseen = 0;
    let unused = 0;
    for (const question of input.pool.get(option.id) ?? []) {
      if (used.has(question.id) || !inDifficultyRange(question.difficulty, turn.difficulty)) continue;
      unused++;
      if (!input.seen.has(question.id)) unseen++;
    }
    if (unused > 0) candidates.push({ option, unseen, unused, lastPlayed: lastPlayedAt.get(option.id) });
  }
  return candidates;
}

/**
 * Wählt 3 Kategorien für den nächsten Zug (siehe Moduldoku); `null`, wenn es keine 3 gibt. Mit einer Auswahl des
 * Hosts (ADR-048) nur aus dieser: reicht sie ohne die Kategorie des letzten Zuges nicht für 3, ist auch diese
 * dabei, und es dürfen 1–2 Optionen sein (genau 1 = feste Kategorie); `null` erst, wenn keine spielbar ist.
 */
export function offerCategories(input: CategoryOfferInput): CategoryOffer | null {
  const { turn, rng } = input;
  const allowed = turn.categoryIds ?? null;
  const limited = allowed !== null;
  const allowedIds = new Set(allowed ?? []);
  const categories = limited ? input.categories.filter((option) => allowedIds.has(option.id)) : input.categories;
  let candidates = candidatesOf(input, categories, true);
  if (limited && candidates.length < 3) candidates = candidatesOf(input, categories, false);

  const full = candidates.filter((candidate) => candidate.unseen >= turn.questionsPerTurn);
  const partial = candidates.filter((candidate) => candidate.unseen < turn.questionsPerTurn);
  const chosen = [...rank(full, rng), ...rank(partial, rng)].slice(0, 3);
  if (chosen.length < (limited ? 1 : 3)) return null;
  return shuffle(chosen, rng).map((candidate) => ({ ...candidate.option }));
}
