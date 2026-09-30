/** Befunde der Content-Prüfungen (validate) – einheitlich formatiert, mit Datei und Zeile. */

export type Severity = "error" | "warning";

export const FINDING_CODES = [
  "categories-missing",
  "categories-json",
  "categories-schema",
  "questions-dir-missing",
  "file-location",
  "json-parse",
  "file-schema",
  "question-schema",
  "unknown-category",
  "unknown-topic",
  "path-mismatch",
  "id-prefix",
  "duplicate-id",
  "answers-not-unique",
  "forbidden-answer",
  "flag-code",
  "asc-not-numeric",
  "answer-in-prompt",
  "whitespace",
  "topic-without-file",
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export interface Finding {
  severity: Severity;
  code: FindingCode;
  /** Pfad relativ zur Repo-Wurzel. */
  file: string;
  line?: number;
  questionId?: string;
  message: string;
}

export function formatFinding(finding: Finding): string {
  const marker = finding.severity === "error" ? "✗" : "⚠";
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  const id = finding.questionId === undefined ? "" : ` ${finding.questionId}`;
  return `${marker} ${location}${id} [${finding.code}] ${finding.message}`;
}

export function countBySeverity(findings: readonly Finding[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const finding of findings) {
    if (finding.severity === "error") errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}
