/**
 * `content:stats`: Mengen je Kategorie, Thema, Schwierigkeit und Status → `content/STATUS.md` (im
 * bestehenden Format) und Lücken für den Ausbau (`--gaps`, docs/08 §7). Gezählt werden in den Tabellen
 * die spielbaren Fragen (`unverified` + `approved`); alle Status stehen in der Kopfzeile.
 */
import { type CategoriesFile, QUESTION_FILE_STATUSES, type QuestionFileStatus } from "@quizmaster/shared/content";
import { formatDate, formatInt, formatPercent } from "./format.ts";
import type { LoadedQuestion } from "./load.ts";

const DIFFICULTY_LEVELS = [1, 2, 3, 4, 5] as const;

export interface TopicStats {
  id: string;
  name: string;
  target: number;
  count: number;
  byDifficulty: number[];
}

export interface CategoryStats {
  slug: string;
  name: string;
  /** Spielbare Fragen. */
  count: number;
  byDifficulty: number[];
  byStatus: Record<QuestionFileStatus, number>;
  targets: { start: number; ausbau: number };
  topics: TopicStats[];
}

export interface CatalogStats {
  /** Spielbare Fragen (unverified + approved). */
  total: number;
  byDifficulty: number[];
  byStatus: Record<QuestionFileStatus, number>;
  flagQuestions: number;
  ascQuestions: number;
  categories: CategoryStats[];
  difficultyMix: CategoriesFile["difficultyMix"];
}

const emptyStatus = (): Record<QuestionFileStatus, number> => ({
  unverified: 0,
  approved: 0,
  needs_fix: 0,
  retired: 0,
});
const emptyDifficulty = () => DIFFICULTY_LEVELS.map(() => 0);

export function isPlayableFileStatus(status: QuestionFileStatus): boolean {
  return status === "unverified" || status === "approved";
}

export function computeStats(categoriesFile: CategoriesFile, questions: readonly LoadedQuestion[]): CatalogStats {
  const categories = [...categoriesFile.categories]
    .sort((a, b) => a.order - b.order)
    .map<CategoryStats>((category) => ({
      slug: category.slug,
      name: category.name,
      count: 0,
      byDifficulty: emptyDifficulty(),
      byStatus: emptyStatus(),
      targets: category.targets,
      topics: category.topics.map((topic) => ({
        id: topic.id,
        name: topic.name,
        target: topic.target,
        count: 0,
        byDifficulty: emptyDifficulty(),
      })),
    }));
  const bySlug = new Map(categories.map((category) => [category.slug, category]));
  const stats: CatalogStats = {
    total: 0,
    byDifficulty: emptyDifficulty(),
    byStatus: emptyStatus(),
    flagQuestions: 0,
    ascQuestions: 0,
    categories,
    difficultyMix: categoriesFile.difficultyMix,
  };
  for (const question of questions) {
    const { entry } = question;
    stats.byStatus[entry.status] += 1;
    const category = bySlug.get(question.category);
    if (category === undefined) continue;
    category.byStatus[entry.status] += 1;
    if (!isPlayableFileStatus(entry.status)) continue;
    const level = entry.difficulty - 1;
    stats.total += 1;
    stats.byDifficulty[level] = (stats.byDifficulty[level] ?? 0) + 1;
    category.count += 1;
    category.byDifficulty[level] = (category.byDifficulty[level] ?? 0) + 1;
    const topic = category.topics.find((candidate) => candidate.id === question.topic);
    if (topic) {
      topic.count += 1;
      topic.byDifficulty[level] = (topic.byDifficulty[level] ?? 0) + 1;
    }
    if (entry.media?.kind === "flag") stats.flagQuestions += 1;
    if (entry.displayOrder === "asc") stats.ascQuestions += 1;
  }
  return stats;
}

const STATUS_DESCRIPTIONS: Record<QuestionFileStatus, string> = {
  unverified: "spielbar, automatisch + redaktionell geprüft, noch nicht einzeln mit Quelle belegt – siehe `docs/08`",
  approved: "spielbar, einzeln mit Quelle belegt – siehe `docs/08`",
  needs_fix: "nicht spielbar, Korrektur nötig – siehe `docs/08`",
  retired: "nicht spielbar – siehe `docs/08`",
};

function statusSentence(byStatus: Record<QuestionFileStatus, number>): string {
  const present = QUESTION_FILE_STATUSES.filter((status) => byStatus[status] > 0);
  if (present.length === 1 && present[0] !== undefined) {
    return `Status aller Fragen: \`${present[0]}\` (${STATUS_DESCRIPTIONS[present[0]]}).`;
  }
  const parts = present.map((status) => `${formatInt(byStatus[status])} \`${status}\``);
  return `Status: ${parts.join(" · ")} – spielbar sind \`unverified\` + \`approved\` (siehe \`docs/08\`).`;
}

function difficultyCells(counts: readonly number[], total: number): string {
  return counts.map((count) => formatPercent(count, total)).join(" | ");
}

/** STATUS.md im bestehenden Format (Kopf, Kategorien-Tabelle, Zielmix, Themen je Kategorie). */
export function renderStatusMarkdown(stats: CatalogStats, generatedAt: Date): string {
  const lines: string[] = [
    "# Fragenkatalog – Status",
    "",
    `> Automatisch erzeugt am ${formatDate(generatedAt)}. ${statusSentence(stats.byStatus)}`,
    "",
    `**Gesamt: ${formatInt(stats.total)} Fragen** in ${stats.categories.length} Kategorien · ` +
      `${formatInt(stats.flagQuestions)} Flaggen-Bildfragen · ${formatInt(stats.ascQuestions)} Fragen mit ` +
      "Zahlenantworten (aufsteigend angezeigt)",
    "",
    "| Kategorie | Fragen | Stufe 1 | Stufe 2 | Stufe 3 | Stufe 4 | Stufe 5 |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const category of stats.categories) {
    lines.push(
      `| ${category.name} | ${formatInt(category.count)} | ${difficultyCells(category.byDifficulty, category.count)} |`,
    );
  }
  lines.push(
    `| **Gesamt** | **${formatInt(stats.total)}** | ${difficultyCells(stats.byDifficulty, stats.total)} |`,
    "",
    `Zielmix: ${DIFFICULTY_LEVELS.map(
      (level, index) =>
        `${index === 0 ? "Stufe " : ""}${level}: ${Math.round((stats.difficultyMix[level] ?? 0) * 100)} %`,
    ).join(" · ")}`,
    "",
  );
  const mixed = QUESTION_FILE_STATUSES.filter((status) => stats.byStatus[status] > 0).length > 1;
  if (mixed) {
    lines.push(
      "## Status je Kategorie",
      "",
      `| Kategorie | ${QUESTION_FILE_STATUSES.join(" | ")} |`,
      `|---|${QUESTION_FILE_STATUSES.map(() => "---:").join("|")}|`,
      ...stats.categories.map(
        (category) =>
          `| ${category.name} | ${QUESTION_FILE_STATUSES.map((status) => formatInt(category.byStatus[status])).join(" | ")} |`,
      ),
      "",
    );
  }
  lines.push("## Themen je Kategorie", "");
  for (const category of stats.categories) {
    lines.push(
      `### ${category.name} (${formatInt(category.count)})`,
      "",
      "| Thema | Fragen | Ziel |",
      "|---|---:|---:|",
    );
    for (const topic of category.topics) {
      lines.push(`| ${topic.name} | ${formatInt(topic.count)} | ${formatInt(topic.target)} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** Kurzüberblick für die Konsole. */
export function renderSummary(stats: CatalogStats): string {
  const rows = stats.categories.map(
    (category) => `  ${category.name.padEnd(24)} ${formatInt(category.count).padStart(6)}`,
  );
  return [
    `Gesamt: ${formatInt(stats.total)} spielbare Fragen in ${stats.categories.length} Kategorien ` +
      `(${statusSentence(stats.byStatus)})`,
    ...rows,
  ].join("\n");
}

/** Lücken bis zum Ausbau-Ziel (`targets.ausbau` je Kategorie, Themen anteilig, Schwierigkeit nach Mix). */
export function renderGaps(stats: CatalogStats): string {
  const lines: string[] = ["Lücken bis zum Ausbau-Ziel (docs/08 §7):"];
  let totalMissing = 0;
  for (const category of stats.categories) {
    const goal = category.targets.ausbau;
    const missing = Math.max(0, goal - category.count);
    totalMissing += missing;
    lines.push(
      "",
      `${category.name}: ${formatInt(category.count)} von ${formatInt(goal)} → fehlen ${formatInt(missing)}`,
    );
    const scale = category.targets.start > 0 ? goal / category.targets.start : 1;
    const topicGaps = category.topics
      .map((topic) => ({ topic, goal: Math.round(topic.target * scale) }))
      .filter(({ topic, goal: topicGoal }) => topic.count < topicGoal)
      .map(({ topic, goal: topicGoal }) => `${topic.name} ${topic.count}/${topicGoal} (−${topicGoal - topic.count})`);
    lines.push(`  Themen: ${topicGaps.length > 0 ? topicGaps.join(" · ") : "alle Themen am Ziel"}`);
    const levelGaps = DIFFICULTY_LEVELS.map((level, index) => {
      const levelGoal = Math.round((stats.difficultyMix[level] ?? 0) * goal);
      const have = category.byDifficulty[index] ?? 0;
      return have < levelGoal ? `${level}: ${have}/${levelGoal} (−${levelGoal - have})` : null;
    }).filter((part): part is string => part !== null);
    lines.push(`  Schwierigkeit: ${levelGaps.length > 0 ? levelGaps.join(" · ") : "Mix erreicht"}`);
  }
  lines.push("", `Insgesamt fehlen ${formatInt(totalMissing)} Fragen bis zum Ausbau-Ziel.`);
  return lines.join("\n");
}
