/**
 * `contentHash` einer Frage (docs/04 §questions): sha256 über ALLE Felder der Frage im Repo – inkl.
 * status, source, review, explanation, media, displayOrder, volatile, asOf – plus Kategorie und Thema
 * der Datei. So erkennt der Seed jede Änderung, auch reine Statuswechsel oder Verschiebungen.
 */
import { createHash } from "node:crypto";
import type { QuestionFileEntry } from "@quizmaster/shared/content";

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** JSON mit rekursiv sortierten Schlüsseln (unabhängig von der Schlüssel-Reihenfolge in Dateien). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError(`Nicht serialisierbarer Wert: ${typeof value}`);
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => compareKeys(a, b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** sha256 (hex) über Kategorie, Thema und alle Felder der Frage. */
export function questionContentHash(category: string, topic: string, entry: QuestionFileEntry): string {
  return createHash("sha256")
    .update(canonicalJson({ category, topic, question: entry }))
    .digest("hex");
}
