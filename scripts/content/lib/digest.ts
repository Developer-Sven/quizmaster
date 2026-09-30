/**
 * `content:digest`: kompakte Liste „Frage → richtige Antwort“ einer Kategorie (optional eines Themas) –
 * Arbeitsgrundlage für neue Fragen, damit kein Fakt doppelt vorkommt (docs/08 §8). Enthält alle Status,
 * nicht spielbare sind markiert.
 */
import type { CategoriesFile } from "@quizmaster/shared/content";
import { formatInt } from "./format.ts";
import type { LoadedQuestion } from "./load.ts";

export function renderDigest(
  categoriesFile: CategoriesFile,
  questions: readonly LoadedQuestion[],
  slug: string,
  topicId?: string,
): string {
  const category = categoriesFile.categories.find((candidate) => candidate.slug === slug);
  if (category === undefined) throw new Error(`Unbekannte Kategorie „${slug}“`);
  const topics = category.topics.filter((topic) => topicId === undefined || topic.id === topicId);
  if (topics.length === 0) throw new Error(`Unbekanntes Thema „${topicId}“ in „${slug}“`);
  const inCategory = questions.filter((question) => question.category === slug);
  const selected = inCategory.filter((question) => topics.some((topic) => topic.id === question.topic));
  const lines = [
    `# Digest ${category.name}${topicId ? ` / ${topics[0]?.name}` : ""} – ${formatInt(selected.length)} Fragen (Frage → richtige Antwort)`,
  ];
  for (const topic of topics) {
    const list = selected.filter((question) => question.topic === topic.id);
    lines.push("", `## ${topic.name} (${topic.id}) – ${formatInt(list.length)}`);
    for (const { entry } of list) {
      const media = entry.media ? ` [Flagge ${entry.media.code}]` : "";
      const status = entry.status === "unverified" ? "" : ` {${entry.status}}`;
      lines.push(`- ${entry.id} (${entry.difficulty})${status} ${entry.prompt}${media} → ${entry.answers[0]}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
