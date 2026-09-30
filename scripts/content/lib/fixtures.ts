/**
 * Synthetische Test-Fixtures (ADR-021): 19 Kategorien mit Namen, Icon, Farbe und Reihenfolge wie im
 * echten Katalog, eigene neutrale Beschreibungen, `targets.minPlayable = 3` und je Kategorie 10–12
 * Fixture-Fragen („Fixture-Frage 3 zu Comics?“) inkl. Flaggen-Bildfragen (Rund um die Welt) und
 * Zahlenfragen (`displayOrder: "asc"`). Keine echten Fragen oder Formulierungen aus `content/`.
 *
 * Deterministisch: gleiche Eingabe → byte-gleiche Dateien (IDs aus sha256 von Kategorie/Thema/Nummer).
 * KONVENTION wie im Katalog: `answers[0]` ist richtig – hier beginnt sie zusätzlich mit „Richtig“,
 * damit E2E-Tests die richtige Antwort ohne Datenbankzugriff erkennen.
 */
import { createHash } from "node:crypto";
import {
  CATEGORY_ID_PREFIXES,
  type CategoriesFile,
  type CategorySlug,
  type QuestionFile,
  type QuestionFileEntry,
} from "@quizmaster/shared/content";

export interface FixtureCategory {
  slug: CategorySlug;
  name: string;
  icon: string;
  color: string;
  order: number;
}

/** Stammdaten wie im echten Katalog (Namen, Lucide-Icons, Farben, Reihenfolge). */
export const FIXTURE_CATEGORIES: readonly FixtureCategory[] = [
  { slug: "buecher-woerter", name: "Bücher & Wörter", icon: "book-open", color: "#EBB447", order: 1 },
  { slug: "comics", name: "Comics", icon: "message-circle", color: "#F7DF45", order: 2 },
  { slug: "computerspiele", name: "Computerspiele", icon: "gamepad-2", color: "#B2DF49", order: 3 },
  { slug: "die-2000er", name: "Die 2000er", icon: "disc-3", color: "#BDC4D1", order: 4 },
  { slug: "draussen-im-gruenen", name: "Draußen im Grünen", icon: "leaf", color: "#47C252", order: 5 },
  { slug: "essen-trinken", name: "Essen & Trinken", icon: "utensils", color: "#F27C5F", order: 6 },
  { slug: "glaube-religion", name: "Glaube & Religion", icon: "scroll-text", color: "#ECDCAC", order: 7 },
  { slug: "im-labor", name: "Im Labor", icon: "flask-conical", color: "#26D9B5", order: 8 },
  { slug: "kinofilme", name: "Kinofilme", icon: "clapperboard", color: "#EE5858", order: 9 },
  { slug: "koerper-geist", name: "Körper & Geist", icon: "brain", color: "#F994A2", order: 10 },
  { slug: "kunst-kultur", name: "Kunst & Kultur", icon: "palette", color: "#EA537B", order: 11 },
  { slug: "macht-geld", name: "Macht & Geld", icon: "landmark", color: "#33CC80", order: 12 },
  { slug: "medien-unterhaltung", name: "Medien & Unterhaltung", icon: "star", color: "#F075B7", order: 13 },
  { slug: "musik-hits", name: "Musik & Hits", icon: "music", color: "#5988F8", order: 14 },
  { slug: "rund-um-die-welt", name: "Rund um die Welt", icon: "globe", color: "#3F9FF3", order: 15 },
  { slug: "sport-freizeit", name: "Sport & Freizeit", icon: "trophy", color: "#7BCB4D", order: 16 },
  { slug: "tv-serien", name: "TV-Serien", icon: "tv", color: "#35C8DE", order: 17 },
  { slug: "wunder-der-technik", name: "Wunder der Technik", icon: "cog", color: "#97B0C4", order: 18 },
  { slug: "zeugen-der-zeit", name: "Zeugen der Zeit", icon: "hourglass", color: "#BA9978", order: 19 },
];

/** Markierung in `categories.json` → der Seed erkennt Fixtures und verweigert Produktion. */
export const FIXTURE_NOTE =
  "SYNTHETISCHE TEST-FIXTURES (scripts/content/make-fixtures.ts) – nur für Tests, CI und E2E; niemals in Produktion seeden.";
export const FIXTURE_DATE = "2026-09-30";
export const FIXTURE_MIN_PLAYABLE = 3;
/** Flaggen der Bildfragen – inkl. Sonderformen (Landesteil, Staatenbund). */
export const FIXTURE_FLAG_CODES = ["de", "gb-eng", "jp", "eu", "fr", "br", "ca"] as const;

const REVIEW = { checkedAt: FIXTURE_DATE, checkedBy: "fakten-pruefer", notes: null };

/** Deterministische Fragen-ID `<kürzel>-<8 Zeichen a–z0–9>`. */
export function fixtureQuestionId(slug: CategorySlug, topic: string, number: number): string {
  const hex = createHash("sha256").update(`quizmaster-fixture:${slug}:${topic}:${number}`).digest("hex");
  const base36 = BigInt(`0x${hex.slice(0, 16)}`)
    .toString(36)
    .padStart(13, "0");
  return `${CATEGORY_ID_PREFIXES[slug]}-${base36.slice(-8)}`;
}

/** 10, 11 oder 12 Fragen je Kategorie (nach Reihenfolge). */
export function fixtureQuestionCount(category: FixtureCategory): number {
  return 10 + (category.order % 3);
}

const germanInt = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

function basicQuestion(category: FixtureCategory, number: number): QuestionFileEntry {
  const entry: QuestionFileEntry = {
    id: fixtureQuestionId(category.slug, "grundlagen", number),
    difficulty: (((number - 1) % 5) + 1) as QuestionFileEntry["difficulty"],
    prompt: `Fixture-Frage ${number} zu ${category.name}?`,
    answers: [`Richtig ${number}`, `Falsch ${number}a`, `Falsch ${number}b`, `Falsch ${number}c`],
    status: "unverified",
  };
  if (number === 2) {
    return {
      ...entry,
      status: "approved",
      source: `https://example.org/fixtures/${category.slug}/${number}`,
      review: REVIEW,
    };
  }
  if (number === 3) return { ...entry, explanation: `Fixture-Erklärung zu Frage ${number}.` };
  if (number === 4) return { ...entry, volatile: true, asOf: "2026-09-01" };
  // Nicht spielbare Sonderfälle für Seed-Tests: je eine Frage „needs_fix“ bzw. „retired“.
  if (number === 5 && category.slug === "comics") {
    return {
      ...entry,
      status: "needs_fix",
      review: { ...REVIEW, notes: "Fixture: absichtlich zur Korrektur markiert" },
    };
  }
  if (number === 5 && category.slug === "kinofilme") return { ...entry, status: "retired" };
  return entry;
}

function numberQuestion(category: FixtureCategory, number: number): QuestionFileEntry {
  // Frage 1: kleine Zahlen; Frage 2: Tausender im deutschen Format („1.300“); richtige Antwort zuerst.
  const correct = number === 1 ? 10 + category.order : 1_000 + 100 * category.order;
  const step = number === 1 ? 3 : 250;
  const values = [correct, correct - step, correct + step, correct + 2 * step];
  return {
    id: fixtureQuestionId(category.slug, "zahlen", number),
    difficulty: number === 1 ? 2 : 4,
    prompt: `Fixture-Zahlenfrage ${number} zu ${category.name}?`,
    answers: values.map((value) => germanInt.format(value)) as QuestionFileEntry["answers"],
    displayOrder: "asc",
    status: "unverified",
  };
}

function flagQuestion(category: FixtureCategory, number: number): QuestionFileEntry {
  const codes = FIXTURE_FLAG_CODES;
  const code = codes[(number - 1) % codes.length] ?? "de";
  const others = [1, 2, 3].map((offset) => codes[(number - 1 + offset) % codes.length] ?? "eu");
  return {
    id: fixtureQuestionId(category.slug, "flaggen", number),
    difficulty: (((number - 1) % 5) + 1) as QuestionFileEntry["difficulty"],
    prompt: `Fixture-Flaggenfrage ${number} zu ${category.name}?`,
    media: { kind: "flag", code },
    answers: [`Richtig (${code})`, ...others.map((other) => `Falsch (${other})`)] as QuestionFileEntry["answers"],
    status: "unverified",
  };
}

export interface FixtureSet {
  categoriesFile: CategoriesFile;
  /** Pfad relativ zum Content-Ordner → Inhalt. */
  questionFiles: Array<{ path: string; file: QuestionFile }>;
}

/** Erzeugt den kompletten Fixture-Katalog. */
export function buildFixtures(): FixtureSet {
  const questionFiles: FixtureSet["questionFiles"] = [];
  const categories = FIXTURE_CATEGORIES.map((category) => {
    const total = fixtureQuestionCount(category);
    const flags = category.slug === "rund-um-die-welt" ? 4 : 0;
    const numbers = 2;
    const basics = total - flags - numbers;
    const topics: CategoriesFile["categories"][number]["topics"] = [
      { id: "grundlagen", name: "Grundlagen", target: basics, method: "ki" },
      { id: "zahlen", name: "Zahlen & Jahre", target: numbers, method: "prozedural" },
    ];
    const files: Array<{ topic: string; questions: QuestionFileEntry[] }> = [
      {
        topic: "grundlagen",
        questions: Array.from({ length: basics }, (_, index) => basicQuestion(category, index + 1)),
      },
      {
        topic: "zahlen",
        questions: Array.from({ length: numbers }, (_, index) => numberQuestion(category, index + 1)),
      },
    ];
    if (flags > 0) {
      topics.push({ id: "flaggen", name: "Flaggen (Bildfragen)", target: flags, method: "wikidata" });
      files.push({
        topic: "flaggen",
        questions: Array.from({ length: flags }, (_, index) => flagQuestion(category, index + 1)),
      });
    }
    for (const { topic, questions } of files) {
      questionFiles.push({
        path: `questions/${category.slug}/${topic}.json`,
        file: { category: category.slug, topic, questions },
      });
    }
    return {
      slug: category.slug,
      name: category.name,
      icon: category.icon,
      color: category.color,
      order: category.order,
      active: true,
      description: `Fixture-Kategorie „${category.name}“ mit synthetischen Testfragen`,
      scope: "Synthetische Testfragen ohne echte Inhalte (nur für automatische Tests).",
      notScope: "Echte Fragen aus dem privaten Katalog (content/).",
      targets: { start: 10, ausbau: 20 },
      rules: [],
      topics,
    };
  });
  const categoriesFile: CategoriesFile = {
    version: 1,
    updated: FIXTURE_DATE,
    note: FIXTURE_NOTE,
    targets: { start: 10, ausbau: 20, minPlayable: FIXTURE_MIN_PLAYABLE },
    difficultyMix: { "1": 0.2, "2": 0.3, "3": 0.25, "4": 0.15, "5": 0.1 },
    methods: {
      ki: "Fixture: von Hand formuliert",
      wikidata: "Fixture: aus einer festen Datenliste erzeugt",
      prozedural: "Fixture: per Code erzeugt",
      mix: "Fixture: gemischt",
    },
    categories,
  };
  return { categoriesFile, questionFiles };
}

/** Erkennt Fixture-Kataloge (Seed-Sicherheitsnetz: nie gegen Produktion). */
export function isFixtureCatalog(categoriesFile: Pick<CategoriesFile, "note">): boolean {
  return /fixture/i.test(categoriesFile.note);
}
