/**
 * Kleine Helfer für die Integrationstests dieses Pakets (nicht Teil der öffentlichen API).
 */
import type { QuestionDoc } from "@quizmaster/shared/documents";
import type { Document } from "mongodb";

/** Sammelt alle `stage`-Namen und verwendeten Indizes eines explain()-Ergebnisses (rekursiv). */
export function planStages(explain: Document): { stages: string[]; indexNames: string[] } {
  const stages: string[] = [];
  const indexNames: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.stage === "string") stages.push(record.stage);
    if (typeof record.indexName === "string") indexNames.push(record.indexName);
    for (const value of Object.values(record)) visit(value);
  };
  visit(explain.queryPlanner ?? explain);
  return { stages, indexNames };
}

/** Gültiges Fragen-Dokument für Tests. */
export function sampleQuestion(id: string, overrides: Partial<QuestionDoc> = {}): QuestionDoc {
  const now = new Date("2026-09-30T12:00:00Z");
  return {
    _id: id,
    category: "comics",
    topic: "grundlagen",
    difficulty: 2,
    prompt: `Testfrage ${id}?`,
    answers: ["Richtig", "Falsch A", "Falsch B", "Falsch C"],
    displayOrder: "shuffle",
    explanation: null,
    media: null,
    volatile: false,
    asOf: null,
    source: null,
    status: "unverified",
    autoRetired: null,
    lang: "de",
    contentHash: "0".repeat(64),
    version: 1,
    stats: { shown: 0, correct: 0, likes: 0, dislikes: 0, reports: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
