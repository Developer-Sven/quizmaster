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
  /** Aus dem Effect `offerCategories`. */
  turn: Pick<TurnRef, "questionsPerTurn" | "playedCategoryIds" | "usedQuestionIds">;
  rng: Rng;
}

export type CategoryOffer = [CategoryOption, CategoryOption, CategoryOption];

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

/** Wählt 3 Kategorien für den nächsten Zug (siehe Moduldoku); `null`, wenn es keine 3 gibt. */
export function offerCategories(input: CategoryOfferInput): CategoryOffer | null {
  const { turn, rng } = input;
  const used = new Set(turn.usedQuestionIds);
  const lastCategory = turn.playedCategoryIds.at(-1);
  const lastPlayedAt = new Map<string, number>();
  turn.playedCategoryIds.forEach((categoryId, index) => {
    lastPlayedAt.set(categoryId, index);
  });

  const candidates: Candidate[] = [];
  const ids = new Set<string>();
  for (const option of input.categories) {
    if (ids.has(option.id) || option.id === lastCategory) continue;
    ids.add(option.id);
    let unseen = 0;
    let unused = 0;
    for (const question of input.pool.get(option.id) ?? []) {
      if (used.has(question.id)) continue;
      unused++;
      if (!input.seen.has(question.id)) unseen++;
    }
    if (unused > 0) candidates.push({ option, unseen, unused, lastPlayed: lastPlayedAt.get(option.id) });
  }

  const full = candidates.filter((candidate) => candidate.unseen >= turn.questionsPerTurn);
  const partial = candidates.filter((candidate) => candidate.unseen < turn.questionsPerTurn);
  const chosen = [...rank(full, rng), ...rank(partial, rng)].slice(0, 3);
  if (chosen.length < 3) return null;
  const [a, b, c] = shuffle(chosen, rng).map((candidate) => ({ ...candidate.option })) as CategoryOffer;
  return [a, b, c];
}
