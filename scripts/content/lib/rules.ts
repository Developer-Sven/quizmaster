/**
 * Inhaltliche Regeln über das Schema hinaus (docs/08 §3, §6, §8): Ablage und Kategorie/Thema,
 * ID-Kürzel und Eindeutigkeit über ALLE Dateien, eindeutige Antworten (auch ohne Groß-/Kleinschreibung),
 * verbotene Sammelantworten, Flaggen-Codes gegen flag-icons. Warnungen (kein Abbruch): Zahlenantworten
 * bei `displayOrder: "asc"`, richtige Antwort im Fragetext, Leerraum.
 */

import { join } from "node:path";
import { type CategorySlug, questionIdMatchesCategory } from "@quizmaster/shared/content";
import type { Finding } from "./findings.ts";
import type { LoadedCatalog, LoadedQuestion } from "./load.ts";
import { CATEGORIES_FILE, displayPath } from "./paths.ts";
import {
  containsPhrase,
  hasWhitespaceProblem,
  isForbiddenAnswer,
  normalizeText,
  parseLeadingGermanNumber,
} from "./text.ts";

export interface RuleOptions {
  /** Gültige Flaggen-Codes (Dateinamen aus flag-icons). */
  flagCodes: ReadonlySet<string>;
}

/** Richtige Antworten unter dieser Länge werden nicht im Fragetext gesucht (zu viele Zufallstreffer). */
const ANSWER_IN_PROMPT_MIN_LENGTH = 4;

function at(question: LoadedQuestion): Pick<Finding, "file" | "line" | "questionId"> {
  return {
    file: question.file,
    ...(question.line === undefined ? {} : { line: question.line }),
    questionId: question.entry.id,
  };
}

function checkQuestion(question: LoadedQuestion, options: RuleOptions, findings: Finding[]): void {
  const { entry } = question;
  const where = at(question);
  if (!questionIdMatchesCategory(entry.id, question.category)) {
    findings.push({
      severity: "error",
      code: "id-prefix",
      ...where,
      message: `ID-Kürzel passt nicht zu „${question.category}“`,
    });
  }
  const normalizedAnswers = entry.answers.map((answer) => normalizeText(answer));
  if (new Set(normalizedAnswers).size !== normalizedAnswers.length) {
    findings.push({
      severity: "error",
      code: "answers-not-unique",
      ...where,
      message: "Antworten sind ohne Groß-/Kleinschreibung bzw. Satzzeichen nicht eindeutig",
    });
  }
  for (const answer of entry.answers) {
    if (isForbiddenAnswer(answer)) {
      findings.push({
        severity: "error",
        code: "forbidden-answer",
        ...where,
        message: `verbotene Antwort „${answer}“`,
      });
    }
  }
  if (entry.media?.kind === "flag" && !options.flagCodes.has(entry.media.code)) {
    findings.push({
      severity: "error",
      code: "flag-code",
      ...where,
      message: `Flaggen-Code „${entry.media.code}“ gibt es in flag-icons nicht`,
    });
  }
  if (entry.displayOrder === "asc") {
    const values = entry.answers.map((answer) => parseLeadingGermanNumber(answer));
    if (values.some((value) => value === null)) {
      findings.push({
        severity: "warning",
        code: "asc-not-numeric",
        ...where,
        message: "displayOrder „asc“, aber nicht alle Antworten beginnen mit einer Zahl",
      });
    } else if (new Set(values).size !== values.length) {
      findings.push({
        severity: "warning",
        code: "asc-not-numeric",
        ...where,
        message: "displayOrder „asc“ mit gleichen Zahlenwerten – Reihenfolge nicht eindeutig",
      });
    }
  }
  const correct = normalizedAnswers[0] ?? "";
  if (correct.length >= ANSWER_IN_PROMPT_MIN_LENGTH && containsPhrase(normalizeText(entry.prompt), correct)) {
    findings.push({
      severity: "warning",
      code: "answer-in-prompt",
      ...where,
      message: `richtige Antwort „${entry.answers[0]}“ steht im Fragetext`,
    });
  }
  if ([entry.prompt, ...entry.answers, entry.explanation ?? ""].some((text) => hasWhitespaceProblem(text))) {
    findings.push({
      severity: "warning",
      code: "whitespace",
      ...where,
      message: "Leerraum am Rand, doppelt oder Umbruch",
    });
  }
}

/** Prüft einen geladenen Katalog; liefert NUR Regel-Befunde (Lade-/Schemabefunde stehen im Katalog). */
export function checkCatalogRules(catalog: LoadedCatalog, options: RuleOptions): Finding[] {
  const findings: Finding[] = [];
  const topicsByCategory = new Map<CategorySlug, Set<string>>(
    (catalog.categoriesFile?.categories ?? []).map((category) => [
      category.slug,
      new Set(category.topics.map((topic) => topic.id)),
    ]),
  );
  const filesByTopic = new Set<string>();

  for (const file of catalog.files) {
    const segments = file.contentPath.split("/");
    if (segments.length !== 3 || segments[0] !== "questions") {
      findings.push({
        severity: "error",
        code: "file-location",
        file: file.file,
        message: "Themen-Dateien gehören nach questions/<kategorie>/<thema>.json",
      });
      continue;
    }
    if (file.category === null || file.topic === null) continue;
    const [, folder, fileName] = segments;
    if (folder !== file.category || fileName !== `${file.topic}.json`) {
      findings.push({
        severity: "error",
        code: "path-mismatch",
        file: file.file,
        message: `Datei liegt nicht unter questions/${file.category}/${file.topic}.json`,
      });
    }
    filesByTopic.add(`${file.category}/${file.topic}`);
    if (catalog.categoriesFile === null) continue;
    const topics = topicsByCategory.get(file.category);
    if (topics === undefined) {
      findings.push({
        severity: "error",
        code: "unknown-category",
        file: file.file,
        message: `Kategorie „${file.category}“ fehlt in categories.json`,
      });
    } else if (!topics.has(file.topic)) {
      findings.push({
        severity: "error",
        code: "unknown-topic",
        file: file.file,
        message: `Thema „${file.topic}“ fehlt in categories.json (${file.category})`,
      });
    }
  }

  const firstSeen = new Map<string, LoadedQuestion>();
  for (const question of catalog.questions) {
    const previous = firstSeen.get(question.entry.id);
    if (previous) {
      const where = previous.line === undefined ? previous.file : `${previous.file}:${previous.line}`;
      findings.push({
        severity: "error",
        code: "duplicate-id",
        ...at(question),
        message: `ID bereits vergeben in ${where}`,
      });
    } else {
      firstSeen.set(question.entry.id, question);
    }
    checkQuestion(question, options, findings);
  }

  for (const category of catalog.categoriesFile?.categories ?? []) {
    for (const topic of category.topics) {
      if (!filesByTopic.has(`${category.slug}/${topic.id}`)) {
        findings.push({
          severity: "warning",
          code: "topic-without-file",
          file: displayPath(join(catalog.contentDir, CATEGORIES_FILE)),
          message: `Thema „${category.slug}/${topic.id}“ hat keine Fragen-Datei`,
        });
      }
    }
  }
  return findings;
}
