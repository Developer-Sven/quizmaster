import type { CategoryOption, Difficulty } from "@quizmaster/shared";
import { DEFAULT_DIFFICULTY_MIX } from "@quizmaster/shared/content";
import { describe, expect, it } from "vitest";
import {
  buildSeenQuestions,
  type CategoryOffer,
  createSeededRng,
  drawQuestions,
  indexPool,
  offerCategories,
  type PoolQuestion,
  type Rng,
} from "../src/index.ts";
import { makeCatalog, questionId } from "./support/fixtures.ts";

const K = 3;

/** Simuliert `turns` Züge: Angebot → Wahl (zufällig) → K Fragen „benutzt“. Prüft jede Regel je Zug. */
function simulateOffers(
  categories: readonly CategoryOption[],
  pool: ReadonlyMap<string, readonly PoolQuestion[]>,
  turns: number,
  rng: Rng,
  seen: ReadonlyMap<string, number> = new Map(),
): { offers: CategoryOffer[]; played: string[] } {
  const played: string[] = [];
  const used: string[] = [];
  const offers: CategoryOffer[] = [];
  for (let turnNumber = 1; turnNumber <= turns; turnNumber++) {
    const offer = offerCategories({
      categories,
      pool,
      seen,
      turn: { questionsPerTurn: K, playedCategoryIds: [...played], usedQuestionIds: [...used] },
      rng,
    });
    if (!offer) throw new Error(`Zug ${turnNumber}: kein Angebot`);
    const ids = offer.map((option) => option.id);
    // Immer 3 verschiedene Kategorien, nie die des letzten Zuges.
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain(played.at(-1));
    const unplayed = categories.map((category) => category.id).filter((id) => !played.includes(id));
    if (unplayed.length >= 3) {
      // Ungespielte zuerst: solange es ≥ 3 gibt, nur ungespielte.
      for (const id of ids) expect(unplayed).toContain(id);
    } else {
      // Alle ungespielten (außer der letzten) sind dabei, der Rest sind die am längsten nicht gespielten.
      for (const id of unplayed.filter((entry) => entry !== played.at(-1))) expect(ids).toContain(id);
      const lastIndex = (id: string) => played.lastIndexOf(id);
      const fillers = ids.filter((id) => played.includes(id));
      const others = [...new Set(played)].filter((id) => id !== played.at(-1) && !ids.includes(id));
      for (const filler of fillers) {
        for (const other of others) expect(lastIndex(filler)).toBeLessThan(lastIndex(other));
      }
    }
    const choice = offer[rng.int(3)];
    if (!choice) throw new Error("keine Wahl");
    played.push(choice.id);
    for (const question of (pool.get(choice.id) ?? []).filter((entry) => !used.includes(entry.id)).slice(0, K)) {
      used.push(question.id);
    }
    offers.push(offer);
  }
  return { offers, played };
}

describe("offerCategories (docs/04 Schritt 4)", () => {
  it("24 Züge (8 Personen × 3 Runden) mit 19 Kategorien: alle Regeln je Zug", () => {
    const catalog = makeCatalog({ categories: 19, perCategory: 60 });
    const { played } = simulateOffers(catalog.categories, catalog.pool, 24, createSeededRng("offer-24"));
    expect(played).toHaveLength(24);
    // Die ersten 18 Züge können nur ungespielte Kategorien bringen (19 − letzte), danach wird aufgefüllt.
    expect(new Set(played.slice(0, 17)).size).toBe(17);
  });

  it("80 Züge (8 × 10) bleiben regelkonform, auch wenn Kategorien knapp werden", () => {
    const catalog = makeCatalog({ categories: 19, perCategory: 40 });
    simulateOffers(catalog.categories, catalog.pool, 80, createSeededRng("offer-80"));
  });

  it("wenige Kategorien: auffüllen mit den am längsten nicht gespielten", () => {
    const catalog = makeCatalog({ categories: 5, perCategory: 200 });
    simulateOffers(catalog.categories, catalog.pool, 30, createSeededRng("offer-5"));
  });

  it("wählt aus mehr als 3 ungespielten gleichverteilt", () => {
    const catalog = makeCatalog({ categories: 6, perCategory: 20 });
    const rng = createSeededRng("fair");
    const counts = new Map<string, number>();
    for (let i = 0; i < 6_000; i++) {
      const offer = offerCategories({
        categories: catalog.categories,
        pool: catalog.pool,
        seen: new Map(),
        turn: { questionsPerTurn: K, playedCategoryIds: [], usedQuestionIds: [] },
        rng,
      });
      for (const option of offer ?? []) counts.set(option.id, (counts.get(option.id) ?? 0) + 1);
    }
    // Jede der 6 Kategorien landet in ~50 % der Angebote (3 von 6).
    for (const count of counts.values()) expect(count / 6_000).toBeCloseTo(0.5, 1);
  });

  it("Kategorien mit < K ungesehenen Fragen erst, wenn es sonst keine 3 gibt", () => {
    const catalog = makeCatalog({ categories: 5, perCategory: 10 });
    const [a, b, c, d, e] = catalog.categories.map((category) => category.id);
    // Für a und b sind alle Fragen gesehen → nur c, d, e haben ≥ K ungesehene.
    const seen = new Map<string, number>();
    for (const id of [a, b]) for (const question of catalog.pool.get(id ?? "") ?? []) seen.set(question.id, 5);
    const rng = createSeededRng("partial");
    for (let i = 0; i < 50; i++) {
      const offer = offerCategories({
        categories: catalog.categories,
        pool: catalog.pool,
        seen,
        turn: { questionsPerTurn: K, playedCategoryIds: [], usedQuestionIds: [] },
        rng,
      });
      expect(offer?.map((option) => option.id).sort()).toEqual([c, d, e].sort());
    }
    // Ist e die Kategorie des letzten Zuges, wird mit einer „knappen“ Kategorie aufgefüllt.
    const offer = offerCategories({
      categories: catalog.categories,
      pool: catalog.pool,
      seen,
      turn: { questionsPerTurn: K, playedCategoryIds: [e ?? ""], usedQuestionIds: [] },
      rng,
    });
    const ids = offer?.map((option) => option.id) ?? [];
    expect(ids).toContain(c);
    expect(ids).toContain(d);
    expect(ids).not.toContain(e);
    expect([a, b]).toContain(ids.find((id) => id !== c && id !== d));
  });

  it("liefert null, wenn es ohne die letzte Kategorie keine 3 mit unbenutzten Fragen gibt", () => {
    const catalog = makeCatalog({ categories: 3, perCategory: 10 });
    const [a] = catalog.categories.map((category) => category.id);
    const offer = offerCategories({
      categories: catalog.categories,
      pool: catalog.pool,
      seen: new Map(),
      turn: { questionsPerTurn: K, playedCategoryIds: [a ?? ""], usedQuestionIds: [] },
      rng: createSeededRng(1),
    });
    expect(offer).toBeNull();
  });

  it("gibt Kopien der Optionen zurück (keine Referenzen in die Eingabe)", () => {
    const catalog = makeCatalog({ categories: 4, perCategory: 10 });
    const offer = offerCategories({
      categories: catalog.categories,
      pool: catalog.pool,
      seen: new Map(),
      turn: { questionsPerTurn: K, playedCategoryIds: [], usedQuestionIds: [] },
      rng: createSeededRng(2),
    });
    for (const option of offer ?? []) expect(catalog.categories).not.toContain(option);
  });
});

describe("drawQuestions (docs/04 Schritt 5)", () => {
  // 4 Themen bei 5 Stufen: Thema und Stufe sind unabhängig (i % 4 vs. i % 5).
  const catalog = makeCatalog({ categories: 2, perCategory: 100, topics: 4 });
  const category = catalog.categories[0]?.id ?? "";

  it("zieht K ungesehene, unbenutzte Fragen, aufsteigend nach Schwierigkeit", () => {
    const rng = createSeededRng("draw");
    const used = new Set<string>();
    for (let turn = 0; turn < 20; turn++) {
      const drawn = drawQuestions({
        categoryId: category,
        count: 3,
        pool: catalog.pool,
        seen: new Map(),
        usedQuestionIds: used,
        difficultyMix: DEFAULT_DIFFICULTY_MIX,
        rng,
      });
      expect(drawn).toHaveLength(3);
      for (const entry of drawn) {
        expect(used.has(entry.id)).toBe(false);
        expect(entry.seen).toBe(false);
        used.add(entry.id);
      }
      const difficulties = drawn.map((entry) => entry.difficulty);
      expect(difficulties).toEqual([...difficulties].sort((a, b) => a - b));
      // Je Zug möglichst gemischt: verschiedene Stufen, verschiedene Themen.
      expect(new Set(difficulties).size).toBe(3);
      expect(new Set(drawn.map((entry) => entry.topic)).size).toBe(3);
    }
    expect(used.size).toBe(60);
  });

  it("vermeidet gesehene Fragen und füllt erst dann auf – älteste zuerst, markiert", () => {
    const pool = catalog.pool.get(category) ?? [];
    const unseenIds = new Set(pool.slice(0, 2).map((question) => question.id));
    // Alle außer 2 gesehen; Alter: je höher der Index, desto länger her.
    const seen = new Map(pool.slice(2).map((question, index) => [question.id, index]));
    const drawn = drawQuestions({
      categoryId: category,
      count: 5,
      pool: catalog.pool,
      seen,
      usedQuestionIds: [],
      difficultyMix: DEFAULT_DIFFICULTY_MIX,
      rng: createSeededRng("refill"),
    });
    expect(drawn).toHaveLength(5);
    expect(
      drawn
        .filter((entry) => !entry.seen)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([...unseenIds].sort());
    const refills = drawn.filter((entry) => entry.seen).map((entry) => seen.get(entry.id) ?? -1);
    const oldestAges = [...seen.values()].sort((a, b) => b - a).slice(0, 3);
    expect(refills.sort((a, b) => b - a)).toEqual(oldestAges);
  });

  it("nie doppelt im Spiel; weniger als K nur, wenn die Kategorie erschöpft ist", () => {
    const pool = catalog.pool.get(category) ?? [];
    const used = pool.slice(0, 98).map((question) => question.id);
    const drawn = drawQuestions({
      categoryId: category,
      count: 3,
      pool: catalog.pool,
      seen: new Map(),
      usedQuestionIds: used,
      difficultyMix: DEFAULT_DIFFICULTY_MIX,
      rng: createSeededRng(1),
    });
    expect(drawn.map((entry) => entry.id).sort()).toEqual([questionId(0, 98), questionId(0, 99)].sort());
    expect(
      drawQuestions({
        categoryId: "gibt-es-nicht",
        count: 3,
        pool: catalog.pool,
        seen: new Map(),
        usedQuestionIds: [],
        difficultyMix: DEFAULT_DIFFICULTY_MIX,
        rng: createSeededRng(1),
      }),
    ).toEqual([]);
  });

  it("gewichtet die Schwierigkeit nach dem Katalog-Mix", () => {
    const rng = createSeededRng("mix");
    const counts = new Map<Difficulty, number>();
    for (let i = 0; i < 4_000; i++) {
      const [first] = drawQuestions({
        categoryId: category,
        count: 1,
        pool: catalog.pool,
        seen: new Map(),
        usedQuestionIds: [],
        difficultyMix: DEFAULT_DIFFICULTY_MIX,
        rng,
      });
      if (first) counts.set(first.difficulty, (counts.get(first.difficulty) ?? 0) + 1);
    }
    for (const [difficulty, share] of Object.entries(DEFAULT_DIFFICULTY_MIX)) {
      expect((counts.get(Number(difficulty) as Difficulty) ?? 0) / 4_000).toBeCloseTo(share, 1);
    }
    // Stufe mit Gewicht 0 wird nie gewählt, solange andere verfügbar sind.
    const onlyEasy = drawQuestions({
      categoryId: category,
      count: 1,
      pool: catalog.pool,
      seen: new Map(),
      usedQuestionIds: [],
      difficultyMix: { "1": 1, "2": 0, "3": 0, "4": 0, "5": 0 },
      rng,
    });
    expect(onlyEasy[0]?.difficulty).toBe(1);
  });

  it("wirft bei count < 1", () => {
    expect(() =>
      drawQuestions({
        categoryId: category,
        count: 0,
        pool: catalog.pool,
        seen: new Map(),
        usedQuestionIds: [],
        difficultyMix: DEFAULT_DIFFICULTY_MIX,
        rng: createSeededRng(1),
      }),
    ).toThrow(RangeError);
  });
});

describe("Pool und gesehene Fragen", () => {
  it("indexPool gruppiert nach Kategorie und ignoriert doppelte IDs", () => {
    const pool = indexPool([
      { id: "rw-00000001", category: "rund-um-die-welt", topic: "a", difficulty: 1 },
      { id: "rw-00000001", category: "rund-um-die-welt", topic: "a", difficulty: 1 },
      { id: "il-00000001", category: "im-labor", topic: "b", difficulty: 2 },
    ]);
    expect(pool.get("rund-um-die-welt")).toHaveLength(1);
    expect(pool.get("im-labor")).toHaveLength(1);
  });

  it("buildSeenQuestions: Alter vom Listenende, jüngstes Sehen gewinnt", () => {
    const seen = buildSeenQuestions([
      ["q1", "q2", "q3"],
      ["q3", "q4"],
    ]);
    expect(seen.get("q3")).toBe(0);
    expect(seen.get("q1")).toBe(2);
    expect(seen.get("q4")).toBe(0);
    expect(seen.get("q2")).toBe(1);
  });
});
