/**
 * Eingabedaten der Auswahlfunktionen (docs/04 §Fragenauswahl 1 + 3): Fragenpool je Kategorie und die für
 * die Lobby gesehenen Fragen. Die Shell hält beides im Speicher (Pool per Change Stream aktuell, gesehene
 * Fragen = Vereinigung der `recentQuestionIds` aller Mitspielenden beim Spielstart).
 */
import type { Difficulty } from "@quizmaster/shared";

/** Eintrag im Pool – Projektion `{ _id, category, topic, difficulty }` einer spielbaren Frage. */
export interface PoolQuestion {
  id: string;
  category: string;
  topic: string;
  difficulty: Difficulty;
}

/** Pool je Kategorie (Kategorie-ID → spielbare Fragen). */
export type QuestionPool = ReadonlyMap<string, readonly PoolQuestion[]>;

/** Gruppiert Pool-Einträge nach Kategorie (doppelte IDs werden ignoriert). */
export function indexPool(questions: Iterable<PoolQuestion>): Map<string, PoolQuestion[]> {
  const pool = new Map<string, PoolQuestion[]>();
  const seenIds = new Set<string>();
  for (const question of questions) {
    if (seenIds.has(question.id)) continue;
    seenIds.add(question.id);
    const list = pool.get(question.category);
    if (list) list.push(question);
    else pool.set(question.category, [question]);
  }
  return pool;
}

/**
 * Gesehene Fragen der Lobby: DB-ID → Alter (0 = zuletzt gesehen, größer = länger her). Grundlage für
 * „gesehene vermeiden“ und „beim Auffüllen die ältesten zuerst“.
 */
export type SeenQuestions = ReadonlyMap<string, number>;

/**
 * Vereinigt `recentQuestionIds` mehrerer Personen (je Liste älteste vorne, neueste hinten). Alter einer
 * Frage = Abstand vom Listenende; hat sie jemand kürzlich gesehen, zählt das jüngste Sehen (kleinstes Alter).
 */
export function buildSeenQuestions(lists: Iterable<readonly string[]>): Map<string, number> {
  const seen = new Map<string, number>();
  for (const list of lists) {
    list.forEach((questionId, index) => {
      const age = list.length - 1 - index;
      const previous = seen.get(questionId);
      if (previous === undefined || age < previous) seen.set(questionId, age);
    });
  }
  return seen;
}
