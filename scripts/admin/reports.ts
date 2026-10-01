// pnpm admin:reports [--json] [--env dev|prod --confirm-prod] [--resolve <id> | --dismiss <id> | --restore <frage-id>]
//                    [--content-dir <pfad>]
//
// Prüf-Queue der Fragenqualität (docs/08 §5, §8): offene Meldungen je Frage (Gründe, Anzahl, Zeitraum),
// automatisch zurückgezogene Fragen (Schutzautomatik), schlecht bewertete Fragen und Fragen mit Trefferquote < 10 %,
// priorisiert wie /faktencheck sie abarbeitet. `--json` ist die Eingabe für /faktencheck. Ausgaben enthalten nie
// guestIds oder Lobby-Codes. Lesen mit `secondaryPreferred` (docs/07).
//
// Aktionen (schreiben – in Produktion wie alles hier nur mit --confirm-prod):
//   --resolve <id>      offene Meldungen erledigt (Frage korrigiert): <id> = Fragen-ID (alle offenen Meldungen der
//                       Frage) oder Meldungs-ID (UUID, eine Meldung)
//   --dismiss <id>      offene Meldungen verworfen (Frage ist korrekt) – wie --resolve
//   --restore <frage>   automatisch zurückgezogene Frage nach Prüfung wieder in den Pool: Status aus dem Content-Repo
//                       (nur wenn die Frage dort unverändert und spielbar ist), danach Live-Zähler der Kategorie
//
// Verbindung aus .env.<env> (Standard dev); Zugangsdaten werden nie ausgegeben.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  AUTO_RETIRE_RATING,
  AUTO_RETIRE_REPORTS,
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

export const USAGE =
  "pnpm admin:reports [--json] [--env dev|prod --confirm-prod] " +
  "[--resolve <id> | --dismiss <id> | --restore <frage-id>] [--content-dir <pfad>]";

/** Version des JSON-Formats für /faktencheck (bei inkompatiblen Änderungen erhöhen). */
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
  | { kind: "restore"; questionId: string };

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
  const chosen = (["resolve", "dismiss", "restore"] as const).filter((key) => values[key] !== undefined);
  if (chosen.length > 1) throw new ReportsUsageError("Nur eine Aktion: --resolve, --dismiss oder --restore");
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

/** Hinweise für den Prüfer (`fakten-pruefer`) – ohne personenbezogene Daten. */
export function reviewHints(item: ReviewQueueItem): string[] {
  const hints: string[] = [];
  if (item.autoRetired !== null) {
    hints.push(
      `automatisch zurückgezogen (${AUTO_RETIRE_LABELS[item.autoRetired.reason]}) am ${day(item.autoRetired.at)} – ` +
        "nicht im Pool, bis die Frage geprüft ist",
    );
  }
  if (item.reports !== null) {
    hints.push(
      `${item.reports.open} offene Meldung${item.reports.open === 1 ? "" : "en"} von ${item.reports.reporters} ` +
        `${item.reports.reporters === 1 ? "Gast" : "Gästen"}: ${reasonSummary(item.reports.byReason)} ` +
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

/** JSON-Dokument der Prüf-Queue für /faktencheck (stabil, `schemaVersion`). */
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
        rating: { minRatings: AUTO_RETIRE_RATING.minRatings, belowPercent: AUTO_RETIRE_RATING.belowPercent },
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
      "--restore <frage-id> (zurückgezogene Frage wieder in den Pool) · --json für /faktencheck",
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

/**
 * Wiederherstellung einer automatisch zurückgezogenen Frage: Status aus dem Content-Repo (Quelle der Wahrheit),
 * nur wenn die Datei-Fassung exakt der gespielten entspricht (`contentHash`) und dort spielbar ist; danach
 * Live-Zähler der Kategorie. Geänderte Fragen übernimmt `pnpm content:seed` (setzt `autoRetired` dabei zurück).
 */
export async function restoreQuestion(
  repos: Repositories,
  questionId: string,
  options: { contentDir: string; pool: QuestionPool; now: Date },
): Promise<RestoreResult> {
  const doc = await repos.questions.findById(questionId);
  if (doc === null) throw new ReportsActionError(`Frage ${questionId} gibt es in der Datenbank nicht`);
  if (doc.autoRetired === null || doc.status !== "retired") {
    throw new ReportsActionError(`Frage ${questionId} ist nicht automatisch zurückgezogen (Status ${doc.status})`);
  }
  const category = categoryIdSchema.parse(doc.category);
  if (!TOPIC_ID_REGEX.test(doc.topic)) throw new ReportsActionError(`Ungültiges Thema „${doc.topic}“`);
  const path = join(options.contentDir, "questions", category, `${doc.topic}.json`);
  if (!isInside(path, options.contentDir) || !existsSync(path)) {
    throw new ReportsActionError(
      `Content-Datei fehlt (${displayPath(path)}) – --content-dir prüfen; ist die Frage verschoben, übernimmt ` +
        "pnpm content:seed den neuen Stand",
    );
  }
  let parsed: ReturnType<typeof questionFileSchema.safeParse>;
  try {
    parsed = questionFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new ReportsActionError(`${displayPath(path)} ist kein gültiges JSON (${describeError(error)})`);
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
      `${questionId} ist im Repo ${entry.status} – erst korrigieren (/faktencheck), dann seeden`,
    );
  }
  const restored = await repos.questions.restoreAutoRetired(
    questionId,
    { status, contentHash: doc.contentHash },
    options.now,
  );
  if (!restored) throw new ReportsActionError(`${questionId} wurde parallel geändert – bitte erneut prüfen`);
  const minPlayable = (await repos.appConfig.get()).catalog.minPlayable;
  const recount = await recountCategory(repos, category, { minPlayable, pool: options.pool }, options.now);
  // Je Gast höchstens eine Meldung pro Frage → verschiedene Gäste = offene Meldungen (Index questionId_createdAt).
  const openReports = await repos.reports.countDistinctReporters(questionId, new Date(0), REPORT_REASONS);
  return {
    questionId,
    status,
    category,
    categoryPlayable: recount?.after.playable ?? null,
    playableCount: recount?.after.playableCount ?? null,
    openReports,
  };
}

export type ActionResult =
  | { action: "resolve" | "dismiss"; target: ReportTarget; changed: number }
  | ({ action: "restore" } & RestoreResult);

/** Führt eine schreibende Aktion aus (Liste: `buildReviewQueue`). */
export async function runReportsAction(
  repos: Repositories,
  action: Exclude<ReportsAction, { kind: "list" }>,
  options: { contentDir: string; pool: QuestionPool; now: Date },
): Promise<ActionResult> {
  if (action.kind === "restore")
    return { action: "restore", ...(await restoreQuestion(repos, action.questionId, options)) };
  const changed = await repos.reports.resolveOpen(action.target, action.kind === "resolve" ? "resolved" : "dismissed");
  return { action: action.kind, target: action.target, changed };
}

export function describeActionResult(result: ActionResult): string {
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
