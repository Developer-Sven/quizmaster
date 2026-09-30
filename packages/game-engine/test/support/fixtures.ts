/**
 * Synthetische Test-Daten (kein echter Katalog): Kategorien mit echten Slugs/ID-Präfixen, Fragen im
 * DB-Format inkl. Feldern, die nie an Clients gehen dürfen (`source`, `stats`, `status` …).
 */
import type { CategoryOption, Difficulty } from "@quizmaster/shared";
import { CATEGORY_ID_PREFIXES, CATEGORY_SLUGS, type DisplayOrder } from "@quizmaster/shared/content";
import type { PoolQuestion, QuestionInput } from "../../src/index.ts";

/** Frage wie aus der DB geladen – mit Feldern, die die Engine verwerfen muss. */
export interface FixtureQuestionDoc extends QuestionInput {
  topic: string;
  source: string | null;
  status: "unverified" | "approved";
  volatile: boolean;
  stats: { shown: number; correct: number; likes: number; dislikes: number; reports: number };
}

export interface Catalog {
  categories: CategoryOption[];
  pool: Map<string, PoolQuestion[]>;
  docs: Map<string, FixtureQuestionDoc>;
}

export interface CatalogOptions {
  /** Anzahl Kategorien (max. 19). */
  categories?: number;
  /** Fragen je Kategorie. */
  perCategory?: number;
  /** Themen je Kategorie. */
  topics?: number;
  /** Jede n-te Frage hat Zahlenantworten mit `displayOrder: "asc"` (0 = keine). */
  numericEvery?: number;
}

const COLORS = ["#3F9FF3", "#26D9B5", "#35C8DE", "#EE5858", "#F7DF45", "#EBB447"] as const;

/** Stabile, gültige Fragen-ID `<Kürzel>-<8 Zeichen a–z0–9>`. */
export function questionId(categoryIndex: number, index: number): string {
  const slug = CATEGORY_SLUGS[categoryIndex];
  if (slug === undefined) throw new RangeError(`Keine Kategorie ${categoryIndex}`);
  return `${CATEGORY_ID_PREFIXES[slug]}-${index.toString(36).padStart(8, "0")}`;
}

export function makeCatalog(options: CatalogOptions = {}): Catalog {
  const categoryCount = options.categories ?? 8;
  const perCategory = options.perCategory ?? 40;
  const topicCount = options.topics ?? 4;
  const numericEvery = options.numericEvery ?? 7;
  const categories: CategoryOption[] = [];
  const pool = new Map<string, PoolQuestion[]>();
  const docs = new Map<string, FixtureQuestionDoc>();
  for (let c = 0; c < categoryCount; c++) {
    const slug = CATEGORY_SLUGS[c];
    if (slug === undefined) throw new RangeError("Höchstens 19 Kategorien");
    categories.push({
      id: slug,
      name: `Kategorie ${c + 1}`,
      icon: "circle",
      color: COLORS[c % COLORS.length] ?? "#3F9FF3",
    });
    const entries: PoolQuestion[] = [];
    for (let i = 0; i < perCategory; i++) {
      const id = questionId(c, i);
      const difficulty = ((i % 5) + 1) as Difficulty;
      const topic = `thema-${i % topicCount}`;
      const numeric = numericEvery > 0 && i % numericEvery === 0;
      const displayOrder: DisplayOrder = numeric ? "asc" : "shuffle";
      const answers: [string, string, string, string] = numeric
        ? ["1.900", "12", "7,5", "300 km"]
        : [`Richtig ${id}`, `Falsch A ${id}`, `Falsch B ${id}`, `Falsch C ${id}`];
      entries.push({ id, category: slug, topic, difficulty });
      docs.set(id, {
        _id: id,
        category: slug,
        topic,
        difficulty,
        displayOrder,
        prompt: `Testfrage ${id} aus ${slug}?`,
        answers,
        explanation: i % 3 === 0 ? `Erklärung zu ${id}` : null,
        media: i % 11 === 0 ? { kind: "flag", code: "de" } : null,
        source: i % 2 === 0 ? "https://example.org/beleg" : null,
        status: i % 2 === 0 ? "approved" : "unverified",
        volatile: false,
        stats: { shown: 0, correct: 0, likes: 0, dislikes: 0, reports: 0 },
      });
    }
    pool.set(slug, entries);
  }
  return { categories, pool, docs };
}

/** Deterministische, gültige UUID (Version 4, Variante 8) für Test-Gäste. */
export function guestUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** Tiefes Einfrieren – beweist, dass `reduce` den Eingabezustand nie verändert (ESM = strict mode). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
