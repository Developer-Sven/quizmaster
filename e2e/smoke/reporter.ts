/**
 * Playwright-Reporter des Smoke-Tests: sammelt je Test Status, Fehler und die Anhänge `smoke:<abschnitt>` und
 * schreibt am Ende `smoke-report.json` und `smoke-report.txt` in den Ausgabeordner; die Kurzfassung erscheint
 * zusätzlich in der Konsole. Läuft im Hauptprozess – bleibt auch bei abstürzenden Workern vollständig.
 */
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { FullResult, Reporter, TestCase, TestError, TestResult } from "@playwright/test/reporter";
import { buildSmokeReport, type CollectedTest, formatSmokeReport, SECTION_PREFIX } from "./report.ts";
import { ARTIFACTS_SUBDIR, HTML_REPORT_SUBDIR } from "./settings.ts";

export interface SmokeReporterOptions {
  outputDir: string;
  baseUrl: string;
  resolveTo: string | null;
  play: boolean;
}

export const REPORT_JSON = "smoke-report.json";
export const REPORT_TEXT = "smoke-report.txt";

/** Pfad für die Ausgabe: relativ zum Aufrufverzeichnis, außerhalb davon absolut. */
export function displayPath(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  if (relativePath === "") return ".";
  return relativePath.startsWith("..") || isAbsolute(relativePath) ? path : relativePath;
}

function errorText(error: TestError): string {
  return stripVTControlCharacters(error.message ?? error.value ?? "unbekannter Fehler");
}

type AttachmentData = { ok: true; data: unknown } | { ok: false; message: string };

/** Anhang → JSON (Inhalt oder Datei). */
function attachmentData(attachment: TestResult["attachments"][number]): AttachmentData {
  try {
    const raw = attachment.body ?? (attachment.path ? readFileSync(attachment.path) : null);
    if (raw === null) return { ok: false, message: "ohne Inhalt" };
    return { ok: true, data: JSON.parse(raw.toString("utf8")) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Ergebnis eines Tests mit seinen Berichtsabschnitten; unlesbare Abschnitte erscheinen als Fehler des Tests. */
export function collectTest(
  test: Pick<TestCase, "title">,
  result: Pick<TestResult, "status" | "duration" | "errors" | "attachments">,
): CollectedTest {
  const collected: CollectedTest = {
    title: test.title,
    status: result.status,
    durationMs: result.duration,
    errors: result.errors.map(errorText),
    sections: [],
  };
  for (const attachment of result.attachments) {
    if (!attachment.name.startsWith(SECTION_PREFIX)) continue;
    const name = attachment.name.slice(SECTION_PREFIX.length);
    const parsed = attachmentData(attachment);
    if (parsed.ok) collected.sections.push({ name, data: parsed.data });
    else collected.errors.push(`Berichtsabschnitt „${name}“ nicht lesbar: ${parsed.message}`);
  }
  return collected;
}

export default class SmokeReporter implements Reporter {
  private readonly options: SmokeReporterOptions;
  private readonly tests: CollectedTest[] = [];
  private readonly globalErrors: string[] = [];
  private startedAt = new Date();

  constructor(options: SmokeReporterOptions) {
    this.options = options;
  }

  onBegin(): void {
    this.startedAt = new Date();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.tests.push(collectTest(test, result));
  }

  onError(error: TestError): void {
    this.globalErrors.push(errorText(error));
  }

  async onEnd(result: FullResult): Promise<void> {
    // Nichts gelaufen (z. B. `--list`): den Bericht des letzten echten Laufs nicht überschreiben.
    if (this.tests.length === 0 && this.globalErrors.length === 0) return;
    const { outputDir } = this.options;
    const shown = (path: string) => displayPath(path, process.env.INIT_CWD ?? process.cwd());
    const jsonPath = join(outputDir, REPORT_JSON);
    const textPath = join(outputDir, REPORT_TEXT);
    const report = buildSmokeReport({
      baseUrl: this.options.baseUrl,
      resolveTo: this.options.resolveTo,
      play: this.options.play,
      startedAt: this.startedAt,
      finishedAt: new Date(),
      status: result.status,
      tests: this.tests,
      globalErrors: this.globalErrors,
      files: {
        json: shown(jsonPath),
        text: shown(textPath),
        html: shown(join(outputDir, HTML_REPORT_SUBDIR)),
        artifacts: shown(join(outputDir, ARTIFACTS_SUBDIR)),
      },
    });
    const text = formatSmokeReport(report);
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(textPath, text);
    console.log(`\n${text}`);
  }

  printsToStdio(): boolean {
    return true;
  }
}
