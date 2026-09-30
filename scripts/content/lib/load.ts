/**
 * Lädt einen Content-Ordner (`categories.json` + `questions/<kategorie>/<thema>.json`) und prüft das
 * Schema je Frage – eine kaputte Frage verhindert nicht die Prüfung der übrigen. Zeilennummern kommen
 * aus der Datei („eine Frage pro Zeile“), damit Befunde direkt anspringbar sind.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  CATEGORY_SLUGS,
  type CategoriesFile,
  type CategorySlug,
  categoriesFileSchema,
  type QuestionFileEntry,
  questionFileEntrySchema,
  questionFileSchema,
  TOPIC_ID_REGEX,
} from "@quizmaster/shared/content";
import { z } from "zod";
import type { Finding } from "./findings.ts";
import { CATEGORIES_FILE, displayPath, QUESTIONS_DIR } from "./paths.ts";

export interface LoadedQuestion {
  category: CategorySlug;
  topic: string;
  entry: QuestionFileEntry;
  /** Pfad relativ zur Repo-Wurzel. */
  file: string;
  line: number | undefined;
}

export interface LoadedFile {
  absPath: string;
  /** Pfad relativ zur Repo-Wurzel. */
  file: string;
  /** Pfad relativ zum Content-Ordner (`questions/<kategorie>/<thema>.json`). */
  contentPath: string;
  category: CategorySlug | null;
  topic: string | null;
  questions: LoadedQuestion[];
  /** Anzahl Einträge in `questions` (auch ungültige). */
  entryCount: number;
}

export interface LoadedCatalog {
  contentDir: string;
  categoriesFile: CategoriesFile | null;
  files: LoadedFile[];
  /** Alle schema-gültigen Fragen (in Datei-Reihenfolge). */
  questions: LoadedQuestion[];
  /** Lade-/Schemabefunde. */
  findings: Finding[];
}

/** Hülle einer Themen-Datei; die Fragen werden einzeln geprüft. */
const fileEnvelopeSchema = z.strictObject({
  category: z.enum(CATEGORY_SLUGS),
  topic: z.string().regex(TOPIC_ID_REGEX),
  questions: z.array(z.unknown()).min(1),
});

const ID_LINE = /"id"\s*:\s*"([^"]+)"/;

/** id → Zeilennummer (1-basiert) in einer Datei mit einer Frage pro Zeile. */
export function indexIdLines(raw: string): Map<string, number> {
  const lines = raw.split("\n");
  const index = new Map<string, number>();
  lines.forEach((line, position) => {
    const match = ID_LINE.exec(line);
    if (match?.[1] !== undefined && !index.has(match[1])) index.set(match[1], position + 1);
  });
  return index;
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.map((part) => String(part)).join(".") || "(Datei)";
}

/** Alle JSON-Dateien unter `questions/` (rekursiv), sortiert. */
export function listQuestionFiles(contentDir: string): string[] {
  const root = join(contentDir, QUESTIONS_DIR);
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".json")) files.push(path);
    }
  };
  walk(root);
  return files;
}

function loadCategories(contentDir: string, findings: Finding[]): CategoriesFile | null {
  const path = join(contentDir, CATEGORIES_FILE);
  const file = displayPath(path);
  if (!existsSync(path)) {
    findings.push({ severity: "error", code: "categories-missing", file, message: "categories.json fehlt" });
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push({ severity: "error", code: "categories-json", file, message: `kein gültiges JSON: ${message}` });
    return null;
  }
  const parsed = categoriesFileSchema.safeParse(json);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      findings.push({
        severity: "error",
        code: "categories-schema",
        file,
        message: `${issuePath(issue.path)}: ${issue.message}`,
      });
    }
    return null;
  }
  return parsed.data;
}

function loadQuestionFile(contentDir: string, absPath: string, findings: Finding[]): LoadedFile {
  const file = displayPath(absPath);
  const contentPath = relative(contentDir, absPath).split(sep).join("/");
  const loaded: LoadedFile = { absPath, file, contentPath, category: null, topic: null, questions: [], entryCount: 0 };
  const raw = readFileSync(absPath, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push({ severity: "error", code: "json-parse", file, message: `kein gültiges JSON: ${message}` });
    return loaded;
  }
  const envelope = fileEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    for (const issue of envelope.error.issues) {
      findings.push({
        severity: "error",
        code: "file-schema",
        file,
        message: `${issuePath(issue.path)}: ${issue.message}`,
      });
    }
    return loaded;
  }
  const { category, topic, questions } = envelope.data;
  loaded.category = category;
  loaded.topic = topic;
  loaded.entryCount = questions.length;
  const lines = indexIdLines(raw);
  let allValid = true;
  questions.forEach((candidate, position) => {
    const id =
      typeof candidate === "object" && candidate !== null && typeof (candidate as { id?: unknown }).id === "string"
        ? (candidate as { id: string }).id
        : undefined;
    const line = id === undefined ? undefined : lines.get(id);
    const parsed = questionFileEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      allValid = false;
      for (const issue of parsed.error.issues) {
        findings.push({
          severity: "error",
          code: "question-schema",
          file,
          ...(line === undefined ? {} : { line }),
          ...(id === undefined ? {} : { questionId: id }),
          message: `Frage ${position + 1}: ${issuePath(issue.path)}: ${issue.message}`,
        });
      }
      return;
    }
    loaded.questions.push({ category, topic, entry: parsed.data, file, line });
  });
  // Gegenprobe mit dem vollständigen Datei-Schema (Quelle der Wahrheit in packages/shared).
  if (allValid) {
    const full = questionFileSchema.safeParse(json);
    if (!full.success) {
      for (const issue of full.error.issues) {
        findings.push({
          severity: "error",
          code: "file-schema",
          file,
          message: `${issuePath(issue.path)}: ${issue.message}`,
        });
      }
    }
  }
  return loaded;
}

/** Lädt Kategorien und alle Themen-Dateien eines Content-Ordners. */
export function loadCatalog(contentDir: string): LoadedCatalog {
  const findings: Finding[] = [];
  const categoriesFile = loadCategories(contentDir, findings);
  const questionsDir = join(contentDir, QUESTIONS_DIR);
  if (!existsSync(questionsDir)) {
    findings.push({
      severity: "error",
      code: "questions-dir-missing",
      file: displayPath(questionsDir),
      message: "Ordner questions/ fehlt",
    });
  }
  const files = listQuestionFiles(contentDir).map((path) => loadQuestionFile(contentDir, path, findings));
  return {
    contentDir,
    categoriesFile,
    files,
    questions: files.flatMap((file) => file.questions),
    findings,
  };
}
