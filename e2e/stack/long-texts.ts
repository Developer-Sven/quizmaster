/**
 * Langtext-Variante der Fixture-Fragen (docs/09 §13: „längste Frage (140 Zeichen) und Antwort (40 Zeichen)
 * passen“). Die Fixtures (`test/fixtures/content`) bleiben unverändert – der Normal-Stack (`normal-stack.ts`)
 * seedet jede Frage mit genau 140 Zeichen Fragetext und genau 40 Zeichen je Antwort: deutsche Sätze mit
 * üblichen Wortlängen und je einem langen Kompositum (realistischer schlimmster Fall für Zeilenumbrüche).
 * `answers[0]` beginnt weiter mit „Richtig“, damit die E2E-Strategie `answer: "correct"` sie erkennt.
 */
import {
  ANSWER_MAX_LENGTH,
  PROMPT_MAX_LENGTH,
  type QuestionFileEntry,
  questionFileEntrySchema,
} from "@quizmaster/shared/content";

/** Zielängen = Höchstwerte des Katalog-Schemas (docs/08 §3). */
export const LONG_PROMPT_LENGTH = PROMPT_MAX_LENGTH;
export const LONG_ANSWER_LENGTH = ANSWER_MAX_LENGTH;

/** Satz für den Fragetext; er wird nach ganzen Wörtern gekürzt und mit einem Wort exakter Länge aufgefüllt. */
const PROMPT_WORDS = (number: number, categoryName: string): string[] =>
  [
    "Welche der vier Antworten passt am besten zu Frage",
    `${number} aus ${categoryName},`,
    "wenn man die Urteile des Bundesverfassungsgerichts aus den letzten zwanzig Jahren genau kennt und die",
    "wichtigsten Entscheidungen noch einmal in aller Ruhe miteinander vergleicht",
  ]
    .join(" ")
    .split(" ");

/** Wörter exakter Länge (2 bis 24 Zeichen) für den Rest – so geht jede Restlänge auf. */
const EXACT_WORDS = [
  "im",
  "und",
  "auch",
  "heute",
  "später",
  "Theater",
  "Forscher",
  "Komponist",
  "Bibliothek",
  "Grundgesetz",
  "Gesellschaft",
  "Kunstsammlung",
  "Fernsehsendung",
  "Bundesregierung",
  "Landeshauptstadt",
  "Naturschutzgebiet",
  "Rechtschreibreform",
  "Verkehrsministerium",
  "Ernährungsberatungen",
  "Weltraumforschungsamt",
  "Straßenbahnhaltestelle",
  "Lebensmittelüberwachung",
  "Bundesverfassungsgericht",
] as const;
const exactWord = new Map<number, string>(EXACT_WORDS.map((word) => [word.length, word]));

/**
 * Antworten mit genau 40 Zeichen: drei mit üblichen Wortlängen, eine mit langem Kompositum. Die erste ist die
 * richtige (Fixture-Konvention „Richtig …“).
 */
export const LONG_ANSWERS = [
  "Richtig ist die längste mögliche Antwort",
  "Eher eine Antwort mit vierzig Buchstaben",
  "Kaum eine Antwort aus dem Jahr 1999 hier",
  "Die Schifffahrtsgesellschaft aus Hamburg",
] as const satisfies readonly [string, string, string, string];

for (const text of LONG_ANSWERS) {
  if (text.length !== LONG_ANSWER_LENGTH) throw new Error(`Antwort mit ${text.length} statt 40 Zeichen: ${text}`);
}

/**
 * Ganze Wörter aus `words`, solange danach noch ein Wort exakter Länge passt, dann genau dieses Wort: Ergebnis
 * hat exakt `length` Zeichen (inklusive `suffix`). Wörter werden nie abgeschnitten.
 */
export function wordsToLength(words: readonly string[], length: number, suffix = ""): string {
  const target = length - suffix.length;
  let text = "";
  for (const word of words) {
    const candidate = text === "" ? word : `${text} ${word}`;
    // Platz für Leerzeichen + Wort exakter Länge (≥ 2 Zeichen) muss bleiben
    if (target - candidate.length < 3) break;
    text = candidate;
  }
  const gap = target - text.length - 1;
  const last = exactWord.get(gap);
  if (last === undefined) throw new Error(`kein Wort mit ${gap} Zeichen für: ${text}`);
  return `${text} ${last}${suffix}`;
}

/** Fragetext mit genau {@link LONG_PROMPT_LENGTH} Zeichen, endet auf „?“ (Schema-Regel). */
export function longPrompt(categoryName: string, number: number): string {
  return wordsToLength(PROMPT_WORDS(number, categoryName), LONG_PROMPT_LENGTH, "?");
}

/**
 * Langtext-Variante eines Fixture-Eintrags: gleiche ID, Schwierigkeit, Status, Quelle und Medien (Flaggen
 * bleiben Bildfragen), nur Fragetext und Antworten sind maximal lang. `displayOrder` entfällt (die
 * Zahlen-Antworten sind jetzt Text). Das Ergebnis ist schema-geprüft.
 */
export function longVariant(entry: QuestionFileEntry, categoryName: string, number: number): QuestionFileEntry {
  const { displayOrder: _displayOrder, ...rest } = entry;
  return questionFileEntrySchema.parse({
    ...rest,
    prompt: longPrompt(categoryName, number),
    answers: [...LONG_ANSWERS],
  });
}
