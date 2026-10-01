// pnpm content:calibrate [--env dev|prod] [--min-shown 30] [--apply] [--content-dir <pfad>]
//
// Kalibrierung aus der Spielstatistik (docs/08 §5, §8): Trefferquote je Frage ab 30 Anzeigen → Vorschlag neue
// Schwierigkeit (1: > 85 %, 2: 65–85 %, 3: 45–65 %, 4: 25–45 %, 5: < 25 %); Trefferquote < 10 % → Prüf-Queue
// (`pnpm admin:reports`) statt neuer Schwierigkeit. Gelesen wird nur (`secondaryPreferred`, docs/07).
//
// --apply schreibt die vorgeschlagenen Schwierigkeiten in die lokalen Content-Dateien – nur die Ziffer in der
// Zeile der Frage ändert sich (Format „eine Frage pro Zeile“, minimaler Diff); `pnpm content:seed` übernimmt sie.
// Übersprungen werden Fragen, deren Datei-Fassung nicht der gespielten entspricht (contentHash – im Repo geändert
// oder nicht geseedet) und Fragen mit offenen Meldungen (erst prüfen; eine Inhaltsänderung setzte sonst das
// Zählfenster der Schutzautomatik zurück).
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  CALIBRATION,
  type CalibrationResult,
  calibrateQuestion,
  closeMongoClient,
  createMongoClient,
  createRepositories,
  describeClientHosts,
  describeError,
  getCollections,
  MONGO_POOL_SIZES,
  questionContentHash,
  type Repositories,
  runStartChecks,
} from "@quizmaster/db";
import { categoryIdSchema, type Difficulty } from "@quizmaster/shared";
import { questionFileSchema, TOPIC_ID_REGEX } from "@quizmaster/shared/content";
import { envFilePath } from "@quizmaster/shared/env";
import type { ReadPreferenceLike } from "mongodb";
import { loadEnv, OpsError } from "../ops/lib/env.ts";
import { DEFAULT_CONTENT_DIR, displayPath, isInside, REPO_ROOT, resolveCliPath } from "./lib/paths.ts";
import { assertTargetDatabase, SeedGuardError } from "./lib/seed-guard.ts";

export const USAGE = "pnpm content:calibrate [--env dev|prod] [--min-shown 30] [--apply] [--content-dir <pfad>]";

export class CalibrateUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrateUsageError";
  }
}

export class CalibrateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrateFileError";
  }
}

export interface CalibrateCommand {
  env: "dev" | "prod";
  minShown: number;
  apply: boolean;
  contentDir: string;
  help: boolean;
}

const OPTIONS = {
  env: { type: "string", default: "dev" },
  "min-shown": { type: "string" },
  apply: { type: "boolean", default: false },
  "content-dir": { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const;

/** Argumente prüfen (ohne Datei- oder Datenbankzugriff). */
export function parseCalibrateArgs(args: readonly string[]): CalibrateCommand {
  let parsed: ReturnType<typeof parseRaw>;
  try {
    parsed = parseRaw(args);
  } catch (error) {
    throw new CalibrateUsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (positionals.length > 0) throw new CalibrateUsageError(`Unerwartete Argumente: ${positionals.join(" ")}`);
  if (values.env !== "dev" && values.env !== "prod") throw new CalibrateUsageError("--env muss dev oder prod sein");
  const rawMin = values["min-shown"];
  const minShown = rawMin === undefined ? CALIBRATION.minShown : Number(rawMin);
  if (!Number.isInteger(minShown) || minShown < 1 || minShown > 1_000_000) {
    throw new CalibrateUsageError(`--min-shown erwartet eine ganze Zahl ≥ 1 (bekommen: ${rawMin})`);
  }
  const contentDir = values["content-dir"];
  return {
    env: values.env,
    minShown,
    apply: values.apply,
    contentDir: contentDir === undefined ? DEFAULT_CONTENT_DIR : resolveCliPath(contentDir),
    help: values.help,
  };
}

function parseRaw(args: readonly string[]) {
  return parseArgs({ args: [...args], options: OPTIONS, allowPositionals: true, strict: true });
}

// --- Position der Schwierigkeit in einer Themen-Datei ----------------------------------------------------------

export interface Span {
  start: number;
  end: number;
}

/**
 * Findet je Frage die Zeichenposition des Werts von `difficulty` (`questions[i].difficulty`) – unabhängig von
 * Formatierung und Schlüsselreihenfolge und ohne auf Text in Strings hereinzufallen (kleiner JSON-Scanner).
 * Wirft `CalibrateFileError` bei ungültigem JSON, doppelten IDs oder fehlender Schwierigkeit.
 */
export function locateDifficulties(text: string): Map<string, Span> {
  let pos = 0;
  const ids = new Map<number, string>();
  const spans = new Map<number, Span>();
  const fail = (message: string): never => {
    throw new CalibrateFileError(`JSON an Position ${pos}: ${message}`);
  };
  const skipWhitespace = () => {
    while (pos < text.length && " \t\n\r".includes(text.charAt(pos))) pos++;
  };
  const consume = (char: string) => {
    skipWhitespace();
    if (text.charAt(pos) !== char) fail(`„${char}“ erwartet`);
    pos++;
  };
  const readString = (): string => {
    skipWhitespace();
    if (text.charAt(pos) !== '"') fail("String erwartet");
    const start = pos;
    pos++;
    while (pos < text.length) {
      const char = text.charAt(pos);
      if (char === "\\") {
        pos += 2;
        continue;
      }
      pos++;
      if (char === '"') return JSON.parse(text.slice(start, pos)) as string;
    }
    return fail("String nicht beendet");
  };
  const SCALAR = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  /** Liest einen Wert; `path` = Schlüssel/Indizes ab der Wurzel. */
  const readValue = (path: readonly (string | number)[]): void => {
    skipWhitespace();
    const char = text.charAt(pos);
    if (char === "{") {
      pos++;
      skipWhitespace();
      if (text.charAt(pos) === "}") {
        pos++;
        return;
      }
      for (;;) {
        const key = readString();
        consume(":");
        readValue([...path, key]);
        skipWhitespace();
        if (text.charAt(pos) === ",") {
          pos++;
          continue;
        }
        consume("}");
        return;
      }
    }
    if (char === "[") {
      pos++;
      skipWhitespace();
      if (text.charAt(pos) === "]") {
        pos++;
        return;
      }
      for (let index = 0; ; index++) {
        readValue([...path, index]);
        skipWhitespace();
        if (text.charAt(pos) === ",") {
          pos++;
          continue;
        }
        consume("]");
        return;
      }
    }
    const isQuestionField = path.length === 3 && path[0] === "questions" && typeof path[1] === "number";
    if (char === '"') {
      const value = readString();
      if (isQuestionField && path[2] === "id" && typeof path[1] === "number") ids.set(path[1], value);
      return;
    }
    SCALAR.lastIndex = pos;
    const match = SCALAR.exec(text);
    if (match === null) throw new CalibrateFileError(`JSON an Position ${pos}: Wert erwartet`);
    if (isQuestionField && path[2] === "difficulty" && typeof path[1] === "number") {
      spans.set(path[1], { start: pos, end: pos + match[0].length });
    }
    pos += match[0].length;
  };
  readValue([]);
  skipWhitespace();
  if (pos !== text.length) fail("Text nach dem JSON-Dokument");

  const result = new Map<string, Span>();
  for (const [index, id] of ids) {
    const span = spans.get(index);
    if (span === undefined) throw new CalibrateFileError(`Frage ${id}: difficulty fehlt`);
    if (result.has(id)) throw new CalibrateFileError(`Fragen-ID doppelt: ${id}`);
    result.set(id, span);
  }
  return result;
}

/**
 * Setzt neue Schwierigkeiten in den Text einer Themen-Datei: ersetzt nur die Ziffern der betroffenen Fragen und
 * prüft danach, dass sich außer diesen Werten nichts geändert hat (und das Schema stimmt). Wirft bei Abweichung.
 */
export function rewriteDifficulties(text: string, changes: ReadonlyMap<string, Difficulty>): string {
  const spans = locateDifficulties(text);
  const edits = [...changes].map(([id, difficulty]) => {
    const span = spans.get(id);
    if (span === undefined) throw new CalibrateFileError(`Frage ${id} nicht in der Datei`);
    return { ...span, value: String(difficulty) };
  });
  edits.sort((a, b) => b.start - a.start);
  let next = text;
  for (const edit of edits) next = `${next.slice(0, edit.start)}${edit.value}${next.slice(edit.end)}`;

  // Gegenprobe: genau die erwarteten Werte geändert, sonst alles gleich; neues Dokument schema-gültig.
  const expected = JSON.parse(text) as { questions: Array<{ id: string; difficulty: number }> };
  for (const question of expected.questions) {
    const difficulty = changes.get(question.id);
    if (difficulty !== undefined) question.difficulty = difficulty;
  }
  const actual: unknown = JSON.parse(next);
  if (!isDeepStrictEqual(actual, expected))
    throw new CalibrateFileError("Gegenprobe fehlgeschlagen – nichts geschrieben");
  if (!questionFileSchema.safeParse(actual).success) {
    throw new CalibrateFileError("Ergebnis verletzt das Schema – nichts geschrieben");
  }
  return next;
}

// --- Ablauf ------------------------------------------------------------------------------------------------------

export type SkipReason = "hash_mismatch" | "open_reports" | "missing_file" | "missing_in_file" | "file_error";

export interface CalibrationPlan {
  /** Fragen mit mindestens `minShown` Anzeigen. */
  evaluated: number;
  /** Vorschläge mit neuer Schwierigkeit. */
  changes: CalibrationResult[];
  /** Trefferquote < 10 % → Prüf-Queue (Schwierigkeit bleibt). */
  review: CalibrationResult[];
  /** Fragen mit offenen Meldungen (werden bei --apply übersprungen). */
  openReports: Set<string>;
  minShown: number;
}

export interface ApplyResult {
  files: string[];
  applied: CalibrationResult[];
  skipped: Array<{ result: CalibrationResult; reason: SkipReason; detail?: string }>;
}

/** Liest die Statistik (Standard `secondaryPreferred`) und berechnet die Vorschläge. */
export async function planCalibration(
  repos: Pick<Repositories, "questions" | "reports">,
  options: { minShown: number; readPreference?: ReadPreferenceLike },
): Promise<CalibrationPlan> {
  const read = options.readPreference === undefined ? {} : { readPreference: options.readPreference };
  const [rows, openReports] = await Promise.all([
    repos.questions.calibrationStats({ ...read, minShown: options.minShown }),
    repos.reports.openQuestionIds(read),
  ]);
  const results = rows
    .map((row) => calibrateQuestion(row, options.minShown))
    .sort(
      (a, b) =>
        a.category.localeCompare(b.category) ||
        a.topic.localeCompare(b.topic) ||
        a.questionId.localeCompare(b.questionId),
    );
  return {
    evaluated: results.length,
    changes: results.filter((result) => result.change),
    review: results.filter((result) => result.review),
    openReports,
    minShown: options.minShown,
  };
}

function writeAtomically(path: string, text: string): void {
  const temp = `${path}.calibrate-${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { mode: statSync(path).mode });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Schreibt die Vorschläge in die Content-Dateien (je Datei einmal, atomar). Nur Fragen, deren Datei-Fassung exakt
 * der gespielten entspricht (`contentHash`) und die keine offenen Meldungen haben.
 */
export function applyCalibration(plan: CalibrationPlan, contentDir: string): ApplyResult {
  const result: ApplyResult = { files: [], applied: [], skipped: [] };
  const byFile = new Map<string, CalibrationResult[]>();
  for (const change of plan.changes) {
    if (plan.openReports.has(change.questionId)) {
      result.skipped.push({ result: change, reason: "open_reports" });
      continue;
    }
    const category = categoryIdSchema.safeParse(change.category);
    if (!category.success || !TOPIC_ID_REGEX.test(change.topic)) {
      result.skipped.push({
        result: change,
        reason: "missing_file",
        detail: `ungültiger Pfad ${change.category}/${change.topic}`,
      });
      continue;
    }
    const path = join(contentDir, "questions", category.data, `${change.topic}.json`);
    const list = byFile.get(path) ?? [];
    list.push(change);
    byFile.set(path, list);
  }
  for (const [path, changes] of byFile) {
    if (!isInside(path, contentDir) || !existsSync(path)) {
      for (const change of changes)
        result.skipped.push({ result: change, reason: "missing_file", detail: displayPath(path) });
      continue;
    }
    try {
      const text = readFileSync(path, "utf8");
      const file = questionFileSchema.parse(JSON.parse(text));
      const entries = new Map(file.questions.map((entry) => [entry.id, entry]));
      const accepted = new Map<string, Difficulty>();
      const acceptedResults: CalibrationResult[] = [];
      for (const change of changes) {
        const entry = entries.get(change.questionId);
        if (entry === undefined) {
          result.skipped.push({ result: change, reason: "missing_in_file", detail: displayPath(path) });
        } else if (questionContentHash(file.category, file.topic, entry) !== change.contentHash) {
          result.skipped.push({ result: change, reason: "hash_mismatch" });
        } else {
          accepted.set(change.questionId, change.suggested);
          acceptedResults.push(change);
        }
      }
      if (accepted.size === 0) continue;
      writeAtomically(path, rewriteDifficulties(text, accepted));
      result.files.push(path);
      result.applied.push(...acceptedResults);
    } catch (error) {
      const detail = error instanceof CalibrateFileError ? error.message : describeError(error);
      for (const change of changes) result.skipped.push({ result: change, reason: "file_error", detail });
    }
  }
  return result;
}

const SKIP_LABELS: Record<SkipReason, string> = {
  hash_mismatch: "im Repo geändert oder nicht geseedet",
  open_reports: "offene Meldungen – erst prüfen (pnpm admin:reports)",
  missing_file: "Content-Datei fehlt",
  missing_in_file: "Frage nicht in der Datei",
  file_error: "Datei nicht bearbeitet",
};

const pct = (rate: number) => `${Math.round(rate * 100)} %`;
const describe = (result: CalibrationResult) =>
  `${result.questionId}  ${result.category}/${result.topic}  ${pct(result.rate)} (${result.correct}/${result.shown})`;

/** Textausgabe von Plan und (optional) Ergebnis von --apply. */
export function formatCalibration(plan: CalibrationPlan, applied: ApplyResult | null): string[] {
  const lines = [
    `${plan.evaluated} Fragen mit ≥ ${plan.minShown} Anzeigen · ${plan.changes.length} Vorschläge · ` +
      `${plan.review.length} zur Prüfung (Trefferquote < ${CALIBRATION.reviewBelowPercent} %) · ` +
      `${plan.evaluated - plan.changes.length - plan.review.length} passen`,
  ];
  const transitions = new Map<string, number>();
  for (const change of plan.changes) {
    const key = `${change.current} → ${change.suggested}`;
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
  }
  if (transitions.size > 0) {
    lines.push(
      `Wechsel: ${[...transitions]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => `${key}: ${count}`)
        .join(" · ")}`,
    );
  }
  if (plan.changes.length > 0) {
    lines.push("", "Vorschläge (Schwierigkeit alt → neu):");
    for (const change of plan.changes) {
      const note = plan.openReports.has(change.questionId) ? "  [offene Meldungen – bei --apply übersprungen]" : "";
      lines.push(`  ${describe(change)}  ${change.current} → ${change.suggested}${note}`);
    }
  }
  if (plan.review.length > 0) {
    lines.push("", "Prüf-Queue (Trefferquote zu niedrig – Antwort prüfen, Schwierigkeit bleibt):");
    for (const review of plan.review) lines.push(`  ${describe(review)}`);
  }
  if (applied === null) {
    if (plan.changes.length > 0) lines.push("", "Nur Vorschau – mit --apply in die Content-Dateien schreiben.");
    return lines;
  }
  lines.push(
    "",
    `--apply: ${applied.applied.length} Fragen in ${applied.files.length} Dateien geändert, ${applied.skipped.length} übersprungen`,
  );
  for (const file of applied.files) lines.push(`  geändert: ${displayPath(file)}`);
  for (const skip of applied.skipped) {
    lines.push(
      `  übersprungen: ${skip.result.questionId} – ${SKIP_LABELS[skip.reason]}${skip.detail ? ` (${skip.detail})` : ""}`,
    );
  }
  if (applied.applied.length > 0) {
    lines.push(
      "Weiter: pnpm content:validate && pnpm content:seed --env dev --dry-run && pnpm content:seed --env dev, " +
        "dann Commit im content-Repo.",
    );
  }
  return lines;
}

// --- CLI ---------------------------------------------------------------------------------------------------------

async function main(args: readonly string[]): Promise<void> {
  const command = parseCalibrateArgs(args);
  if (command.help) {
    console.info(USAGE);
    return;
  }
  if (command.apply && !existsSync(join(command.contentDir, "questions"))) {
    throw new CalibrateUsageError(`Content-Ordner fehlt (${displayPath(command.contentDir)}) – --content-dir angeben`);
  }
  const source = loadEnv(envFilePath(REPO_ROOT, command.env));
  const dbName = source.MONGODB_DB;
  const prefix = dbName.endsWith("_test") ? source.MONGODB_COLLECTION_PREFIX : undefined;
  assertTargetDatabase(command.env, dbName, prefix);
  const client = createMongoClient(source.MONGODB_URI, {
    appName: "quizmaster-calibrate",
    maxPoolSize: MONGO_POOL_SIZES.script,
    cache: false,
  });
  try {
    console.info(
      `content:calibrate – Ziel ${describeClientHosts(client)} / ${dbName}${prefix ? ` (Präfix ${prefix})` : ""} · ` +
        `env ${command.env} · nur lesend (secondaryPreferred)`,
    );
    await runStartChecks(client, { allowInsecureTransport: command.env === "dev" });
    const repos = createRepositories(client, getCollections(client.db(dbName), { prefix }));
    const plan = await planCalibration(repos, { minShown: command.minShown });
    const applied = command.apply ? applyCalibration(plan, command.contentDir) : null;
    for (const line of formatCalibration(plan, applied)) console.info(line);
  } finally {
    await closeMongoClient(client);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const usage = error instanceof CalibrateUsageError;
    const known = usage || error instanceof SeedGuardError || error instanceof OpsError;
    const message = known && error instanceof Error ? error.message : `Fehler: ${describeError(error)}`;
    console.error(
      `content:calibrate – ${message.replace(/mongodb(\+srv)?:\/\/\S*/g, "mongodb://***")}${usage ? `\nAufruf: ${USAGE}` : ""}`,
    );
    process.exit(usage ? 2 : 1);
  }
}
