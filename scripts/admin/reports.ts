// pnpm admin:reports [--json] [--env dev|prod --confirm-prod] [--resolve <id> | --dismiss <id> | --restore <frage-id>
//                    | --restore-auto --since <iso> [--reason reports|rating] [--dry-run] | --recount <kategorie>]
//                    [--content-dir <pfad>]
//
// Prüf-Queue der Fragenqualität (docs/08 §5, §8): offene Meldungen je Frage (Gründe, Anzahl, Zeitraum),
// automatisch zurückgezogene Fragen (Schutzautomatik), schlecht bewertete Fragen und Fragen mit Trefferquote < 10 %,
// priorisiert wie der Faktencheck sie abarbeitet. `--json` ist die Eingabe für den Faktencheck. Ausgaben enthalten
// nie guestIds oder Lobby-Codes. Lesen mit `secondaryPreferred` (docs/07).
//
// Aktionen (schreiben – in Produktion wie alles hier nur mit --confirm-prod):
//   --resolve <id>      offene Meldungen erledigt (Frage korrigiert): <id> = Fragen-ID (alle offenen Meldungen der
//                       Frage) oder Meldungs-ID (UUID, eine Meldung)
//   --dismiss <id>      offene Meldungen verworfen (Frage ist korrekt) – wie --resolve
//   --restore <frage>   automatisch zurückgezogene Frage nach Prüfung wieder in den Pool: Status aus dem Content-Repo
//                       (nur wenn die Frage dort unverändert und spielbar ist), danach Live-Zähler der Kategorie
//   --restore-auto --since <iso> [--reason reports|rating] [--dry-run]
//                       Massen-Wiederherstellung (z. B. nach Missbrauch der Meldungen, Watchdog-Alarm `auto_retire`):
//                       alle seit <iso> automatisch zurückgezogenen Fragen wie --restore (gleiche Prüfungen, im Repo
//                       geänderte oder nicht spielbare werden übersprungen), Live-Zähler je Kategorie einmal am Ende –
//                       auch nach einem Abbruch mitten im Lauf (z. B. Datenbank weg: ein neuer Lauf fände die schon
//                       wiederhergestellten nicht mehr). Abbruch oder gescheiterte Neuberechnung → Exit-Code 1;
//                       --dry-run zeigt nur, was passieren würde. Offene Meldungen bleiben in der Queue (zählen nach
//                       der Wiederherstellung nicht mehr für die Schutzautomatik).
//   --recount <kat>     Live-Zähler einer Kategorie neu berechnen (playableCount, approvedCount, playable) – z. B.
//                       wenn die Neuberechnung nach --restore-auto scheiterte
//
// Verbindung aus .env.<env> (Standard dev); Zugangsdaten werden nie ausgegeben.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  AUTO_RETIRE_BUDGET,
  AUTO_RETIRE_RATING,
  AUTO_RETIRE_REASONS,
  AUTO_RETIRE_REPORTS,
  type AutoRetireReason,
  buildReviewQueue,
  closeMongoClient,
  createMongoClient,
  createRepositories,
  describeClientHosts,
  describeError,
  getCollections,
  MONGO_POOL_SIZES,
  type QuestionPool,
  questionContentHash,
  type Repositories,
  type ReviewQueue,
  type ReviewQueueItem,
  recountCategory,
  runStartChecks,
} from "@quizmaster/db";
import { categoryIdSchema, REPORT_REASONS, type ReportReason } from "@quizmaster/shared";
import { QUESTION_ID_REGEX, questionFileSchema, TOPIC_ID_REGEX, toDbQuestionStatus } from "@quizmaster/shared/content";
import { envFilePath } from "@quizmaster/shared/env";
import type { MongoClient } from "mongodb";
import { DEFAULT_CONTENT_DIR, displayPath, isInside, REPO_ROOT, resolveCliPath } from "../content/lib/paths.ts";
import { assertProdConfirmed, assertTargetDatabase, SeedGuardError } from "../content/lib/seed-guard.ts";
import { loadEnv, OpsError } from "../ops/lib/env.ts";
import { ISO_INSTANT_HINT, parseIsoInstant } from "../ops/lib/iso-time.ts";

export const USAGE =
  "pnpm admin:reports [--json] [--env dev|prod --confirm-prod] " +
  "[--resolve <id> | --dismiss <id> | --restore <frage-id> | " +
  "--restore-auto --since <iso> [--reason reports|rating] [--dry-run] | --recount <kategorie>] [--content-dir <pfad>]";

/** Version des JSON-Formats für den Faktencheck (bei inkompatiblen Änderungen erhöhen). */
export const REVIEW_QUEUE_SCHEMA_VERSION = 1;

const REPORT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ReportsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportsUsageError";
  }
}

/** Fachlicher Abbruch einer Aktion (z. B. Frage im Repo geändert). */
export class ReportsActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportsActionError";
  }
}

export type ReportTarget = { questionId: string } | { reportId: string };

export type ReportsAction =
  | { kind: "list" }
  | { kind: "resolve" | "dismiss"; target: ReportTarget }
  | { kind: "restore"; questionId: string }
  | { kind: "restore-auto"; since: Date; reason: AutoRetireReason | null; dryRun: boolean }
  | { kind: "recount"; category: string };

export interface ReportsCommand {
  env: "dev" | "prod";
  confirmProd: boolean;
  json: boolean;
  contentDir: string;
  action: ReportsAction;
  help: boolean;
}

/** Fragen-ID (`rw-8f3k2m1q`) oder Meldungs-ID (UUID). */
export function parseReportTarget(value: string): ReportTarget {
  const trimmed = value.trim();
  if (QUESTION_ID_REGEX.test(trimmed)) return { questionId: trimmed };
  if (REPORT_ID_REGEX.test(trimmed.toLowerCase())) return { reportId: trimmed.toLowerCase() };
  throw new ReportsUsageError(`„${value}“ ist weder eine Fragen-ID (z. B. rw-8f3k2m1q) noch eine Meldungs-ID (UUID)`);
}

const OPTIONS = {
  json: { type: "boolean", default: false },
  env: { type: "string", default: "dev" },
  "confirm-prod": { type: "boolean", default: false },
  resolve: { type: "string" },
  dismiss: { type: "string" },
  restore: { type: "string" },
  "restore-auto": { type: "boolean", default: false },
  since: { type: "string" },
  reason: { type: "string" },
  "dry-run": { type: "boolean", default: false },
  recount: { type: "string" },
  "content-dir": { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const;

function parseRaw(args: readonly string[]) {
  try {
    return parseArgs({ args: [...args], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new ReportsUsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Argumente prüfen (ohne Datei- oder Datenbankzugriff). */
export function parseReportsArgs(args: readonly string[]): ReportsCommand {
  const parsed = parseRaw(args);
  const { values, positionals } = parsed;
  if (positionals.length > 0) throw new ReportsUsageError(`Unerwartete Argumente: ${positionals.join(" ")}`);
  if (values.env !== "dev" && values.env !== "prod") throw new ReportsUsageError("--env muss dev oder prod sein");
  const chosen = (["resolve", "dismiss", "restore", "recount"] as const).filter((key) => values[key] !== undefined);
  if (chosen.length + (values["restore-auto"] ? 1 : 0) > 1) {
    throw new ReportsUsageError("Nur eine Aktion: --resolve, --dismiss, --restore, --restore-auto oder --recount");
  }
  let action: ReportsAction = { kind: "list" };
  if (values.resolve !== undefined) action = { kind: "resolve", target: parseReportTarget(values.resolve) };
  if (values.dismiss !== undefined) action = { kind: "dismiss", target: parseReportTarget(values.dismiss) };
  if (values.restore !== undefined) {
    const questionId = values.restore.trim();
    if (!QUESTION_ID_REGEX.test(questionId)) {
      throw new ReportsUsageError(`--restore erwartet eine Fragen-ID (z. B. rw-8f3k2m1q), nicht „${values.restore}“`);
    }
    action = { kind: "restore", questionId };
  }
  if (values.recount !== undefined) {
    const category = categoryIdSchema.safeParse(values.recount.trim());
    if (!category.success) {
      throw new ReportsUsageError(`--recount erwartet eine Kategorie (z. B. kinofilme), nicht „${values.recount}“`);
    }
    action = { kind: "recount", category: category.data };
  }
  if (values["restore-auto"]) {
    if (values.since === undefined) {
      throw new ReportsUsageError("--restore-auto braucht --since <iso> (ab wann automatisch zurückgezogene Fragen)");
    }
    const since = parseIsoInstant(values.since);
    if (since === null) throw new ReportsUsageError(`--since erwartet ${ISO_INSTANT_HINT}`);
    const reason = values.reason ?? null;
    if (reason !== null && !(AUTO_RETIRE_REASONS as readonly string[]).includes(reason)) {
      throw new ReportsUsageError(`--reason erwartet ${AUTO_RETIRE_REASONS.join(" oder ")}`);
    }
    action = { kind: "restore-auto", since, reason: reason as AutoRetireReason | null, dryRun: values["dry-run"] };
  } else if (values.since !== undefined || values.reason !== undefined || values["dry-run"]) {
    throw new ReportsUsageError("--since, --reason und --dry-run nur zusammen mit --restore-auto");
  }
  const contentDir = values["content-dir"];
  return {
    env: values.env,
    confirmProd: values["confirm-prod"],
    json: values.json,
    contentDir: contentDir === undefined ? DEFAULT_CONTENT_DIR : resolveCliPath(contentDir),
    action,
    help: values.help,
  };
}

// --- Ausgabe ---------------------------------------------------------------------------------------------------

export interface QueueContext {
  env: "dev" | "prod";
  /** Datenbankname (ohne Host oder Zugangsdaten). */
  database: string;
}

const REASON_ORDER: readonly ReportReason[] = ["falsch", "veraltet", "mehrdeutig", "tippfehler", "unpassend"];
const FLAG_LABELS: Record<ReviewQueueItem["flags"][number], string> = {
  auto_retired: "ZURÜCKGEZOGEN",
  reports: "MELDUNGEN",
  low_rating: "BEWERTUNG",
  low_hit_rate: "TREFFERQUOTE",
};
const AUTO_RETIRE_LABELS = { reports: "Meldungen", rating: "Bewertungen" } as const;

const day = (date: Date) => date.toISOString().slice(0, 10);
const percent = (ratio: number) => `${Math.round(ratio * 100)} %`;

/** Content-Datei einer Frage relativ zum Content-Ordner (`questions/<kategorie>/<thema>.json`). */
export function contentFileOf(item: Pick<ReviewQueueItem, "category" | "topic">): string | null {
  if (item.category === null || item.topic === null) return null;
  return `questions/${item.category}/${item.topic}.json`;
}

function reasonSummary(byReason: Partial<Record<ReportReason, number>>): string {
  return REASON_ORDER.filter((reason) => (byReason[reason] ?? 0) > 0)
    .map((reason) => `${reason} ${byReason[reason]}`)
    .join(", ");
}

/** Hinweise für den Faktencheck – ohne personenbezogene Daten. */
export function reviewHints(item: ReviewQueueItem): string[] {
  const hints: string[] = [];
  if (item.autoRetired !== null) {
    hints.push(
      `automatisch zurückgezogen (${AUTO_RETIRE_LABELS[item.autoRetired.reason]}) am ${day(item.autoRetired.at)} – ` +
        "nicht im Pool, bis die Frage geprüft ist",
    );
  }
  if (item.reports !== null) {
    const { severeReporters, severeSources } = item.reports;
    // Unabhängige Quellen (ADR-058): Was die Schutzautomatik zählt – über IP oder Lobby verbundene Gäste als eine.
    const sources =
      severeReporters === 0
        ? ""
        : `, schwere Gründe aus ${severeSources} unabhängigen Quelle${severeSources === 1 ? "" : "n"}`;
    hints.push(
      `${item.reports.open} offene Meldung${item.reports.open === 1 ? "" : "en"} von ${item.reports.reporters} ` +
        `${item.reports.reporters === 1 ? "Gast" : "Gästen"}${sources}: ${reasonSummary(item.reports.byReason)} ` +
        `(${day(item.reports.firstAt)} bis ${day(item.reports.lastAt)})`,
    );
  }
  if (item.ratingWindow !== null) {
    const { likes, dislikes, quote, since } = item.ratingWindow;
    hints.push(
      `Bewertung ${quote === null ? "–" : percent(quote)} Daumen hoch (${likes} hoch, ${dislikes} runter` +
        `${since === null ? "" : ` seit ${day(since)}`}) – Formulierung/Distraktoren prüfen`,
    );
  }
  if (item.hitRate !== null) {
    hints.push(
      `Trefferquote ${percent(item.hitRate.rate)} (${item.hitRate.correct} von ${item.hitRate.shown}) – ` +
        "richtige Antwort und Eindeutigkeit prüfen",
    );
  }
  return hints;
}

/** JSON-Dokument der Prüf-Queue für den Faktencheck (stabil, `schemaVersion`). */
export function queueToJson(queue: ReviewQueue, context: QueueContext) {
  return {
    schemaVersion: REVIEW_QUEUE_SCHEMA_VERSION,
    kind: "quizmaster-review-queue",
    generatedAt: queue.generatedAt.toISOString(),
    env: context.env,
    database: context.database,
    thresholds: {
      autoRetire: {
        reports: {
          minReporters: AUTO_RETIRE_REPORTS.minReporters,
          windowDays: AUTO_RETIRE_REPORTS.windowMs / (24 * 60 * 60 * 1_000),
          reasons: [...AUTO_RETIRE_REPORTS.reasons],
        },
        rating: {
          minRatings: AUTO_RETIRE_RATING.minRatings,
          belowPercent: AUTO_RETIRE_RATING.belowPercent,
          minDislikeSources: AUTO_RETIRE_RATING.minDislikeSources,
        },
        budget: {
          windowHours: AUTO_RETIRE_BUDGET.windowMs / 3_600_000,
          perCategory: AUTO_RETIRE_BUDGET.perCategory,
          total: AUTO_RETIRE_BUDGET.total,
        },
      },
      ratingWatch: queue.thresholds.ratingWatch,
      calibration: queue.thresholds.calibration,
    },
    totals: queue.totals,
    truncated: queue.truncated,
    items: queue.items.map((item) => ({
      questionId: item.questionId,
      file: contentFileOf(item),
      category: item.category,
      topic: item.topic,
      difficulty: item.difficulty,
      status: item.status,
      prompt: item.prompt,
      flags: item.flags,
      tier: item.tier,
      autoRetired:
        item.autoRetired === null ? null : { reason: item.autoRetired.reason, at: item.autoRetired.at.toISOString() },
      reports:
        item.reports === null
          ? null
          : {
              open: item.reports.open,
              reporters: item.reports.reporters,
              severeReporters: item.reports.severeReporters,
              severeSources: item.reports.severeSources,
              byReason: item.reports.byReason,
              firstAt: item.reports.firstAt.toISOString(),
              lastAt: item.reports.lastAt.toISOString(),
              reportIds: item.reports.reportIds,
            },
      rating:
        item.ratingWindow === null
          ? null
          : {
              likes: item.ratingWindow.likes,
              dislikes: item.ratingWindow.dislikes,
              quotePercent: item.ratingWindow.quote === null ? null : Math.round(item.ratingWindow.quote * 1_000) / 10,
              since: item.ratingWindow.since?.toISOString() ?? null,
            },
      hitRate:
        item.hitRate === null
          ? null
          : {
              shown: item.hitRate.shown,
              correct: item.hitRate.correct,
              percent: Math.round(item.hitRate.rate * 1_000) / 10,
            },
      stats: item.stats,
      updatedAt: item.updatedAt?.toISOString() ?? null,
      hints: reviewHints(item),
    })),
  };
}

/** Textausgabe der Prüf-Queue (eine priorisierte Liste, je Frage alle Befunde). */
export function formatQueueText(queue: ReviewQueue, context: QueueContext): string[] {
  const { totals } = queue;
  const lines = [
    `Prüf-Queue · ${context.database} (env ${context.env}) · Stand ${queue.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    `${totals.items} Fragen · ${totals.openReports} offene Meldungen zu ${totals.questionsWithReports} Fragen · ` +
      `${totals.autoRetired} automatisch zurückgezogen · ${totals.lowRating} schlecht bewertet · ` +
      `${totals.lowHitRate} mit Trefferquote < ${queue.thresholds.calibration.reviewBelowPercent} %`,
  ];
  if (queue.truncated.reports || queue.truncated.autoRetired) {
    lines.push("Hinweis: Liste gekürzt (Höchstzahl erreicht) – erst die vorderen Einträge abarbeiten.");
  }
  if (queue.items.length === 0) {
    lines.push("", "Keine Fragen zu prüfen.");
    return lines;
  }
  queue.items.forEach((item, index) => {
    const where = item.category === null ? "Frage fehlt in der DB" : `${item.category}/${item.topic}`;
    const flags = item.flags.map((flag) => FLAG_LABELS[flag]).join(" · ");
    lines.push("", `${index + 1}. ${item.questionId} · ${where} · ${item.status ?? "–"} · [${flags}]`);
    if (item.prompt !== null) lines.push(`   „${item.prompt}“`);
    for (const hint of reviewHints(item)) lines.push(`   – ${hint}`);
    const file = contentFileOf(item);
    if (file !== null) lines.push(`   Datei: content/${file}`);
  });
  lines.push(
    "",
    "Aktionen: --resolve <frage-id|meldungs-id> (korrigiert) · --dismiss <…> (unbegründet) · " +
      "--restore <frage-id> (zurückgezogene Frage wieder in den Pool) · --restore-auto --since <iso> [--dry-run] " +
      "(alle seit dann zurückgezogenen) · --recount <kategorie> (Live-Zähler neu) · --json für den Faktencheck",
  );
  return lines;
}

// --- Aktionen ----------------------------------------------------------------------------------------------------

export interface RestoreResult {
  questionId: string;
  status: "unverified" | "approved";
  category: string;
  /** Live-Zähler der Kategorie nach der Wiederherstellung (`null`, wenn sie fehlt). */
  categoryPlayable: boolean | null;
  playableCount: number | null;
  /** Noch offene Meldungen der Frage (mit --resolve/--dismiss abschließen). */
  openReports: number;
}

interface RestorePlan {
  status: "unverified" | "approved";
  category: string;
  contentHash: string;
  autoRetired: { reason: AutoRetireReason; at: Date };
}

type ParsedQuestionFile = ReturnType<typeof questionFileSchema.safeParse>;

/**
 * Prüft, ob eine automatisch zurückgezogene Frage wiederhergestellt werden darf, und liefert den Status aus dem
 * Content-Repo (Quelle der Wahrheit) – nur, wenn die Datei-Fassung exakt der gespielten entspricht (`contentHash`)
 * und dort spielbar ist. Wirft `ReportsActionError` mit dem Grund. `files` puffert gelesene Themen-Dateien.
 */
async function planRestore(
  repos: Repositories,
  questionId: string,
  contentDir: string,
  files: Map<string, ParsedQuestionFile> = new Map(),
): Promise<RestorePlan> {
  const doc = await repos.questions.findById(questionId);
  if (doc === null) throw new ReportsActionError(`Frage ${questionId} gibt es in der Datenbank nicht`);
  if (doc.autoRetired === null || doc.status !== "retired") {
    throw new ReportsActionError(`Frage ${questionId} ist nicht automatisch zurückgezogen (Status ${doc.status})`);
  }
  const category = categoryIdSchema.parse(doc.category);
  if (!TOPIC_ID_REGEX.test(doc.topic)) throw new ReportsActionError(`Ungültiges Thema „${doc.topic}“`);
  const path = join(contentDir, "questions", category, `${doc.topic}.json`);
  if (!isInside(path, contentDir) || !existsSync(path)) {
    throw new ReportsActionError(
      `Content-Datei fehlt (${displayPath(path)}) – --content-dir prüfen; ist die Frage verschoben, übernimmt ` +
        "pnpm content:seed den neuen Stand",
    );
  }
  let parsed = files.get(path);
  if (parsed === undefined) {
    try {
      parsed = questionFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      throw new ReportsActionError(`${displayPath(path)} ist kein gültiges JSON (${describeError(error)})`);
    }
    files.set(path, parsed);
  }
  if (!parsed.success) throw new ReportsActionError(`${displayPath(path)} ist ungültig – pnpm content:validate`);
  const entry = parsed.data.questions.find((candidate) => candidate.id === questionId);
  if (entry === undefined) {
    throw new ReportsActionError(
      `${questionId} steht nicht in ${displayPath(path)} – verschoben oder entfernt? pnpm content:seed übernimmt den Stand`,
    );
  }
  if (questionContentHash(parsed.data.category, parsed.data.topic, entry) !== doc.contentHash) {
    throw new ReportsActionError(
      `${questionId} wurde im Repo geändert – pnpm content:seed übernimmt die neue Fassung und setzt autoRetired dabei zurück`,
    );
  }
  const status = toDbQuestionStatus(entry.status);
  if (status === "retired") {
    throw new ReportsActionError(
      `${questionId} ist im Repo ${entry.status} – erst korrigieren (Faktencheck), dann seeden`,
    );
  }
  return { status, category, contentHash: doc.contentHash, autoRetired: doc.autoRetired };
}

/** Live-Zähler einer Kategorie nach einer Wiederherstellung. */
async function recountAfterRestore(
  repos: Repositories,
  category: string,
  options: { pool: QuestionPool; now: Date },
): Promise<{ playable: boolean | null; playableCount: number | null }> {
  const minPlayable = (await repos.appConfig.get()).catalog.minPlayable;
  const recount = await recountCategory(repos, category, { minPlayable, pool: options.pool }, options.now);
  return { playable: recount?.after.playable ?? null, playableCount: recount?.after.playableCount ?? null };
}

/**
 * Wiederherstellung einer automatisch zurückgezogenen Frage (Prüfungen siehe `planRestore`); danach Live-Zähler der
 * Kategorie. Geänderte Fragen übernimmt `pnpm content:seed` (setzt `autoRetired` dabei zurück).
 */
export async function restoreQuestion(
  repos: Repositories,
  questionId: string,
  options: { contentDir: string; pool: QuestionPool; now: Date },
): Promise<RestoreResult> {
  const plan = await planRestore(repos, questionId, options.contentDir);
  const restored = await repos.questions.restoreAutoRetired(
    questionId,
    { status: plan.status, contentHash: plan.contentHash },
    options.now,
  );
  if (!restored) throw new ReportsActionError(`${questionId} wurde parallel geändert – bitte erneut prüfen`);
  const counts = await recountAfterRestore(repos, plan.category, options);
  // Je Gast höchstens eine Meldung pro Frage → verschiedene Gäste = offene Meldungen (Index questionId_createdAt).
  const openReports = await repos.reports.countDistinctReporters(questionId, new Date(0), REPORT_REASONS);
  return {
    questionId,
    status: plan.status,
    category: plan.category,
    categoryPlayable: counts.playable,
    playableCount: counts.playableCount,
    openReports,
  };
}

/** Ergebnis von `--restore-auto` (Massen-Wiederherstellung). */
export interface BulkRestoreResult {
  since: Date;
  reason: AutoRetireReason | null;
  dryRun: boolean;
  /** Automatisch zurückgezogene Fragen seit `since` (ggf. nur dieses Grunds), neueste zuerst. */
  candidates: number;
  /** Wiederhergestellt (bzw. im Dry-Run: würden wiederhergestellt), neueste zuerst. */
  restored: Array<{
    questionId: string;
    status: "unverified" | "approved";
    category: string;
    autoRetired: { reason: AutoRetireReason; at: Date };
  }>;
  /** Nicht wiederhergestellt – mit Grund (im Repo geändert, needs_fix, Datei fehlt, parallel geändert). */
  skipped: Array<{ questionId: string; problem: string }>;
  /** Live-Zähler je Kategorie der wiederhergestellten Fragen (nicht im Dry-Run) – auch nach einem Abbruch. */
  categories: CategoryRecountResult[];
  /**
   * Abbruch mitten im Lauf (z. B. Datenbank weg): ab `questionId` wurde nichts mehr versucht; `null` = vollständig.
   * Die schon wiederhergestellten Fragen sind im Pool und ihre Kategorien neu gezählt – ein neuer Lauf setzt fort.
   */
  aborted: { questionId: string; problem: string } | null;
  /** Mehr Kandidaten als die Höchstzahl je Lauf – danach erneut ausführen. */
  truncated: boolean;
}

/** Live-Zähler einer Kategorie nach `--restore-auto`. */
export interface CategoryRecountResult {
  category: string;
  /** `null`: Kategorie nicht gefunden – oder die Neuberechnung ist gescheitert (`problem`). */
  playable: boolean | null;
  playableCount: number | null;
  /** Neuberechnung gescheitert (nachholen mit `--recount <kategorie>`), sonst `null`. */
  problem: string | null;
}

/** Neuberechnung je Kategorie der wiederhergestellten Fragen – einzeln: Ein Fehler hält die übrigen nicht auf. */
async function recountCategories(
  repos: Repositories,
  categories: Iterable<string>,
  options: { pool: QuestionPool; now: Date },
): Promise<CategoryRecountResult[]> {
  const results: CategoryRecountResult[] = [];
  for (const category of [...new Set(categories)].sort()) {
    try {
      results.push({ category, ...(await recountAfterRestore(repos, category, options)), problem: null });
    } catch (error) {
      results.push({ category, playable: null, playableCount: null, problem: sanitize(describeError(error)) });
    }
  }
  return results;
}

/**
 * Massen-Wiederherstellung: alle seit `since` automatisch zurückgezogenen Fragen (optional nur eines Grunds) mit
 * denselben Prüfungen wie `--restore`. Gelesen wird vom Primary (danach wird geschrieben); die Live-Zähler laufen je
 * Kategorie mit einem Schreibversuch einmal am Ende – auch wenn ein Fehler ohne fachlichen Grund (z. B. Datenbank
 * weg) den Lauf abbricht, auch nach einem Schreibfehler mit offenem Ausgang:
 * Sonst blieben die Kategorien der schon wiederhergestellten Fragen auf dem Stand der Rückzüge (ggf. `playable: false`),
 * und ein neuer Lauf fände diese Fragen nicht mehr (`autoRetired` ist zurückgesetzt). Ergebnis mit `aborted` bzw.
 * `problem` je Kategorie → `reportsActionFailed` (Exit-Code 1).
 */
export async function restoreAutoRetiredSince(
  repos: Repositories,
  action: Extract<ReportsAction, { kind: "restore-auto" }>,
  options: { contentDir: string; pool: QuestionPool; now: Date },
): Promise<BulkRestoreResult> {
  const { questions, truncated } = await repos.questions.listAutoRetired({
    readPreference: "primary",
    since: action.since,
    ...(action.reason === null ? {} : { reason: action.reason }),
  });
  const files = new Map<string, ParsedQuestionFile>();
  const restored: BulkRestoreResult["restored"] = [];
  const skipped: BulkRestoreResult["skipped"] = [];
  let aborted: BulkRestoreResult["aborted"] = null;
  /** Kategorien mit einem Schreibversuch – auch einem, dessen Ausgang offen ist (Neuberechnung ist idempotent). */
  const touched = new Set<string>();
  for (const question of questions) {
    try {
      const plan = await planRestore(repos, question._id, options.contentDir, files);
      if (!action.dryRun) {
        // Vor dem Schreiben merken: Wirft der Zugriff, nachdem der Server das Update schon angewandt hat
        // (mehrdeutiger Ausgang bei einem Netzaussetzer), wird die Kategorie trotzdem neu gezählt.
        touched.add(plan.category);
        const done = await repos.questions.restoreAutoRetired(
          question._id,
          { status: plan.status, contentHash: plan.contentHash },
          options.now,
        );
        if (!done) {
          skipped.push({ questionId: question._id, problem: "parallel geändert – bitte erneut prüfen" });
          continue;
        }
      }
      restored.push({
        questionId: question._id,
        status: plan.status,
        category: plan.category,
        autoRetired: plan.autoRetired,
      });
    } catch (error) {
      if (error instanceof ReportsActionError) {
        skipped.push({ questionId: question._id, problem: error.message });
        continue;
      }
      // Ohne fachlichen Grund (Datenbank, Netz): abbrechen – die Live-Zähler folgen trotzdem (unten).
      aborted = { questionId: question._id, problem: sanitize(describeError(error)) };
      break;
    }
  }
  const categories = action.dryRun ? [] : await recountCategories(repos, touched, options);
  return {
    since: action.since,
    reason: action.reason,
    dryRun: action.dryRun,
    candidates: questions.length,
    restored,
    skipped,
    categories,
    aborted,
    truncated,
  };
}

/** `--recount`: Live-Zähler einer Kategorie neu berechnen; fehlt sie, bricht die Aktion fachlich ab. */
async function recountOnly(
  repos: Repositories,
  category: string,
  options: { pool: QuestionPool; now: Date },
): Promise<{ category: string; playable: boolean; playableCount: number }> {
  const counts = await recountAfterRestore(repos, category, options);
  if (counts.playable === null || counts.playableCount === null) {
    throw new ReportsActionError(`Kategorie ${category} gibt es in der Datenbank nicht`);
  }
  return { category, playable: counts.playable, playableCount: counts.playableCount };
}

export type ActionResult =
  | { action: "resolve" | "dismiss"; target: ReportTarget; changed: number }
  | ({ action: "restore" } & RestoreResult)
  | ({ action: "restore-auto" } & BulkRestoreResult)
  | { action: "recount"; category: string; playable: boolean; playableCount: number };

/**
 * Liegt ein Ergebnis vor, ist aber etwas gescheitert (Abbruch mitten in `--restore-auto` oder eine Neuberechnung
 * der Live-Zähler)? Dann endet das Werkzeug mit Exit-Code 1.
 */
export function reportsActionFailed(result: ActionResult): boolean {
  if (result.action !== "restore-auto") return false;
  return result.aborted !== null || result.categories.some((entry) => entry.problem !== null);
}

/** Führt eine schreibende Aktion aus (Liste: `buildReviewQueue`). */
export async function runReportsAction(
  repos: Repositories,
  action: Exclude<ReportsAction, { kind: "list" }>,
  options: { contentDir: string; pool: QuestionPool; now: Date },
): Promise<ActionResult> {
  if (action.kind === "restore")
    return { action: "restore", ...(await restoreQuestion(repos, action.questionId, options)) };
  if (action.kind === "restore-auto") {
    return { action: "restore-auto", ...(await restoreAutoRetiredSince(repos, action, options)) };
  }
  if (action.kind === "recount") return { action: "recount", ...(await recountOnly(repos, action.category, options)) };
  const changed = await repos.reports.resolveOpen(action.target, action.kind === "resolve" ? "resolved" : "dismissed");
  return { action: action.kind, target: action.target, changed };
}

/** Mehrzeilige Ausgabe einer Massen-Wiederherstellung (nur Fragen-IDs, Kategorien und Zahlen). */
function describeBulkRestore(result: BulkRestoreResult): string {
  const scope = `seit ${result.since.toISOString()}${result.reason === null ? "" : `, Grund ${AUTO_RETIRE_LABELS[result.reason]}`}`;
  const head = result.dryRun
    ? `Dry-Run – würde ${result.restored.length} von ${result.candidates} automatisch zurückgezogenen Fragen (${scope}) wiederherstellen`
    : `${result.restored.length} von ${result.candidates} automatisch zurückgezogenen Fragen (${scope}) wiederhergestellt – Realtime übernimmt sie per Change Stream`;
  const lines = [head];
  for (const entry of result.restored) {
    lines.push(
      `  ${result.dryRun ? "würde" : "wieder"}: ${entry.questionId} · ${entry.category} · ${entry.status} (zurückgezogen ${entry.autoRetired.at.toISOString()}, ${AUTO_RETIRE_LABELS[entry.autoRetired.reason]})`,
    );
  }
  for (const entry of result.skipped) lines.push(`  übersprungen: ${entry.questionId} – ${entry.problem}`);
  if (result.aborted !== null) {
    lines.push(
      `  ABGEBROCHEN bei ${result.aborted.questionId}: ${result.aborted.problem} – die übrigen bleiben zurückgezogen ` +
        "(erneut ausführen setzt fort); Live-Zähler der schon wiederhergestellten: Kategorien unten",
    );
  }
  for (const entry of result.categories) {
    if (entry.problem !== null) {
      lines.push(
        `  Kategorie ${entry.category}: Live-Zähler NICHT neu berechnet (${entry.problem}) – nachholen: ` +
          `pnpm admin:reports --recount ${entry.category} (mit denselben --env/--confirm-prod)`,
      );
      continue;
    }
    lines.push(
      entry.playable === null
        ? `  Kategorie ${entry.category} nicht gefunden`
        : `  Kategorie ${entry.category}: ${entry.playableCount} spielbare Fragen, ${entry.playable ? "spielbar" : "NICHT spielbar"}`,
    );
  }
  if (result.truncated) lines.push("  Höchstzahl je Lauf erreicht – danach erneut ausführen");
  if (result.restored.length > 0) {
    lines.push(
      "  Offene Meldungen bleiben in der Prüf-Queue (zählen nicht erneut) – nach Prüfung mit --dismiss <frage-id> abschließen",
    );
  }
  return lines.join("\n");
}

export function describeActionResult(result: ActionResult): string {
  if (result.action === "restore-auto") return describeBulkRestore(result);
  if (result.action === "recount") {
    return `Kategorie ${result.category} neu gezählt: ${result.playableCount} spielbare Fragen, ${result.playable ? "spielbar" : "NICHT spielbar"}`;
  }
  if (result.action === "restore") {
    const category =
      result.categoryPlayable === null
        ? `Kategorie ${result.category} nicht gefunden`
        : `Kategorie ${result.category}: ${result.playableCount} spielbare Fragen, ${result.categoryPlayable ? "spielbar" : "NICHT spielbar"}`;
    const reports =
      result.openReports > 0
        ? ` · ${result.openReports} offene Meldung(en) – abschließen mit --dismiss ${result.questionId} oder --resolve ${result.questionId}`
        : "";
    return `${result.questionId} wiederhergestellt (Status ${result.status}, Realtime übernimmt per Change Stream) · ${category}${reports}`;
  }
  const target = "questionId" in result.target ? `zu ${result.target.questionId}` : result.target.reportId;
  const verb = result.action === "resolve" ? "als erledigt markiert" : "verworfen";
  return result.changed === 0
    ? `keine offene Meldung ${target} gefunden (schon abgeschlossen?)`
    : `${result.changed} offene Meldung(en) ${target} ${verb}`;
}

// --- CLI ---------------------------------------------------------------------------------------------------------

/** Ersetzt Zugangsdaten in Fehlermeldungen (nie ausgeben). */
function sanitize(message: string): string {
  return message.replace(/mongodb(\+srv)?:\/\/\S*/g, "mongodb://***");
}

async function main(args: readonly string[]): Promise<void> {
  const command = parseReportsArgs(args);
  if (command.help) {
    console.info(USAGE);
    return;
  }
  // 1. Prüfungen ohne Datei-/Datenbankzugriff: Produktion nur mit Bestätigung (auch nur lesend).
  assertProdConfirmed(command.env, command.confirmProd);
  // 2. Verbindung aus .env.<env>.
  const source = loadEnv(envFilePath(REPO_ROOT, command.env));
  const dbName = source.MONGODB_DB;
  const prefix = dbName.endsWith("_test") ? source.MONGODB_COLLECTION_PREFIX : undefined;
  assertTargetDatabase(command.env, dbName, prefix);
  const client: MongoClient = createMongoClient(source.MONGODB_URI, {
    appName: "quizmaster-admin-reports",
    maxPoolSize: MONGO_POOL_SIZES.script,
    cache: false,
  });
  try {
    const log = (line: string) =>
      command.json ? console.error(`admin:reports – ${line}`) : console.info(`admin:reports – ${line}`);
    log(`Ziel ${describeClientHosts(client)} / ${dbName}${prefix ? ` (Präfix ${prefix})` : ""} · env ${command.env}`);
    await runStartChecks(client, { allowInsecureTransport: command.env === "dev" });
    const repos = createRepositories(client, getCollections(client.db(dbName), { prefix }));
    const now = new Date();
    if (command.action.kind === "list") {
      const queue = await buildReviewQueue(repos, { now });
      const context: QueueContext = { env: command.env, database: dbName };
      if (command.json) console.info(JSON.stringify(queueToJson(queue, context), null, 2));
      else for (const line of formatQueueText(queue, context)) console.info(line);
      return;
    }
    const result = await runReportsAction(repos, command.action, {
      contentDir: command.contentDir,
      pool: source.QUESTION_POOL ?? "all",
      now,
    });
    if (command.json) console.info(JSON.stringify(result, null, 2));
    else log(describeActionResult(result));
    // Teilweise gescheitert (Abbruch, Neuberechnung): Ergebnis steht oben, der Exit-Code meldet es.
    if (reportsActionFailed(result)) process.exitCode = 1;
  } finally {
    await closeMongoClient(client);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const usage = error instanceof ReportsUsageError;
    const known =
      usage || error instanceof ReportsActionError || error instanceof SeedGuardError || error instanceof OpsError;
    const message = known && error instanceof Error ? error.message : `Fehler: ${describeError(error)}`;
    console.error(`admin:reports – ${sanitize(message)}${usage ? `\nAufruf: ${USAGE}` : ""}`);
    process.exit(usage ? 2 : 1);
  }
}
