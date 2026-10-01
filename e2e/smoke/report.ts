/**
 * Bericht des Smoke-Tests: Die Tests hängen ihre Messwerte als JSON-Anhänge `smoke:<abschnitt>` an, der Reporter
 * (reporter.ts) sammelt sie und schreibt daraus `smoke-report.json` und `smoke-report.txt` (reine Funktionen hier).
 */
import type { BrowserProblem } from "../tests/support/monitor.ts";
import type { AxeFinding } from "../tests/support/screen-checks.ts";
import type { ColdStartResult } from "./cold-start.ts";
import type { HeaderCheck } from "./headers.ts";
import type { PwaReport } from "./pwa.ts";

/** Präfix der Anhänge, die in den Bericht eingehen. */
export const SECTION_PREFIX = "smoke:";

/** Hinweis für die Bereinigung der Testspiele (Befehl aus der Admin-CLI, docs/06). */
export function purgeCommand(code: string): string {
  return `pnpm admin:game purge --code ${code} --env <env> [--confirm-prod]`;
}

export interface LobbySection {
  code: string;
  createdAt: string;
}

export interface AxeSection {
  /** z. B. „lobby-host“ */
  screen: string;
  person: string;
  device: string;
  violations: AxeFinding[];
  /** von axe nicht entscheidbare Regeln (nur Information) */
  incomplete: number;
  passes: number;
  /** Layout-/Design-Befunde aus `checkScreen` (horizontales Scrollen, mehrere Hauptaktionen …) */
  layout: string[];
  screenshot: string | null;
}

export interface GamePlayer {
  name: string;
  device: string;
  host: boolean;
  finished: boolean;
  picks: number;
  answers: number;
  missedAnswers: number;
  /** Überschrift am Spielende, z. B. „Gewonnen“ */
  headline: string | null;
  left: boolean;
}

export interface GameSection {
  code: string;
  /** Spiel gestartet (der Host hat „Spiel starten“ ausgelöst) */
  played: boolean;
  /** Grund, falls nicht gespielt (z. B. `SMOKE_PLAY=0`); `null` + `played: false` = Start gescheitert */
  skipReason: string | null;
  rounds: number;
  questionsPerCategory: number;
  /** Start → Spielende bei beiden */
  durationMs: number | null;
  players: GamePlayer[];
}

export interface HeadersSection {
  url: string;
  status: number;
  checks: HeaderCheck[];
  /** nur Information: `X-Robots-Tag`, `cf-cache-status`, `server` */
  info: Record<string, string | null>;
}

export interface BrowserSection {
  messages: number;
  problems: BrowserProblem[];
  /** Konsolenprotokoll („[Person] typ: text (url)“), gekürzt auf {@link CONSOLE_LINES_PER_TEST} Zeilen */
  console: string[];
}

/** Höchstzahl der Konsolenzeilen je Test im Bericht (vollständig im HTML-Bericht). */
export const CONSOLE_LINES_PER_TEST = 200;

export type TestStatus = "passed" | "failed" | "timedOut" | "skipped" | "interrupted";

/** Ergebnis eines Tests, wie der Reporter es einsammelt. */
export interface CollectedTest {
  title: string;
  status: TestStatus;
  durationMs: number;
  errors: string[];
  sections: { name: string; data: unknown }[];
}

export interface SmokeReportInput {
  baseUrl: string;
  resolveTo: string | null;
  play: boolean;
  startedAt: Date;
  finishedAt: Date;
  status: "passed" | "failed" | "timedout" | "interrupted";
  tests: CollectedTest[];
  /** Fehler außerhalb der Tests (Konfiguration, Worker) */
  globalErrors: string[];
  files: SmokeReport["files"];
}

export interface SmokeReport {
  schemaVersion: 1;
  baseUrl: string;
  resolveTo: string | null;
  play: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: SmokeReportInput["status"];
  checks: { title: string; status: TestStatus; durationMs: number; errors: string[] }[];
  globalErrors: string[];
  coldStart: ColdStartResult | null;
  game: GameSection | null;
  axe: AxeSection[];
  pwa: PwaReport | null;
  headers: HeadersSection | null;
  browser: {
    messages: number;
    console: string[];
    cspViolations: string[];
    consoleErrors: string[];
    pageErrors: string[];
    crashes: string[];
  };
  /**
   * Bereinigung: alle angelegten Lobbys; Befehle für jede Lobby, in der ein Spiel gestartet wurde oder deren
   * Verlauf unbekannt ist (z. B. Worker-Absturz) – `purge` ist idempotent und zeigt mit `--dry-run` die Wirkung.
   */
  cleanup: { lobbyCodes: string[]; commands: string[] };
  files: { json: string; text: string; html: string; artifacts: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Abschnitte aller Tests mit diesem Namen (die Daten stammen aus den eigenen Tests – geprüft wird die Form). */
function sections<T>(tests: readonly CollectedTest[], name: string, guard: (data: Record<string, unknown>) => boolean) {
  const found: T[] = [];
  for (const test of tests) {
    for (const section of test.sections) {
      if (section.name === name && isRecord(section.data) && guard(section.data)) found.push(section.data as T);
    }
  }
  return found;
}

const isLobby = (data: Record<string, unknown>) => typeof data.code === "string";
const isColdStart = (data: Record<string, unknown>) =>
  typeof data.openToLobbyMs === "number" && typeof data.code === "string";
const isAxe = (data: Record<string, unknown>) => typeof data.screen === "string" && Array.isArray(data.violations);
const isGame = (data: Record<string, unknown>) => typeof data.played === "boolean" && Array.isArray(data.players);
const isPwa = (data: Record<string, unknown>) =>
  Array.isArray(data.installabilityErrors) && isRecord(data.manifest) && isRecord(data.serviceWorker);
const isHeaders = (data: Record<string, unknown>) => Array.isArray(data.checks) && typeof data.url === "string";
const isBrowser = (data: Record<string, unknown>) => Array.isArray(data.problems) && typeof data.messages === "number";

/** Baut den Bericht aus den eingesammelten Tests. */
export function buildSmokeReport(input: SmokeReportInput): SmokeReport {
  const { tests } = input;
  const browserSections = sections<BrowserSection>(tests, "browser", isBrowser);
  const problems = browserSections.flatMap((section) => section.problems);
  const problemTexts = (kind: BrowserProblem["kind"]) =>
    problems.filter((problem) => problem.kind === kind).map((problem) => `[${problem.page}] ${problem.text}`);
  const games = sections<GameSection>(tests, "game", isGame);
  const lobbyCodes = [
    ...new Set([
      ...sections<LobbySection>(tests, "lobby", isLobby).map((lobby) => lobby.code),
      ...games.map((game) => game.code),
    ]),
  ];
  // Ohne Spiel (SMOKE_PLAY=0, Abbruch vor dem Start) gibt es nichts zu bereinigen.
  const purgeCodes = lobbyCodes.filter((code) => !games.some((game) => game.code === code && !game.played));
  return {
    schemaVersion: 1,
    baseUrl: input.baseUrl,
    resolveTo: input.resolveTo,
    play: input.play,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    status: input.status,
    checks: tests.map(({ title, status, durationMs, errors }) => ({ title, status, durationMs, errors })),
    globalErrors: input.globalErrors,
    coldStart: sections<ColdStartResult>(tests, "cold-start", isColdStart).at(-1) ?? null,
    game: games.at(-1) ?? null,
    axe: sections<AxeSection>(tests, "axe", isAxe),
    pwa: sections<PwaReport>(tests, "pwa", isPwa).at(-1) ?? null,
    headers: sections<HeadersSection>(tests, "headers", isHeaders).at(-1) ?? null,
    browser: {
      messages: browserSections.reduce((sum, section) => sum + section.messages, 0),
      console: browserSections.flatMap((section) => (Array.isArray(section.console) ? section.console : [])),
      cspViolations: problemTexts("csp"),
      consoleErrors: problemTexts("console"),
      pageErrors: problemTexts("pageerror"),
      crashes: problemTexts("crash"),
    },
    cleanup: { lobbyCodes, commands: purgeCodes.map(purgeCommand) },
    files: input.files,
  };
}

const DECIMAL = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SHORT_DECIMAL = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** Zielwerte und Profile ohne überflüssige Nullen: 10 s, 1,8 s, 0,75 Mbit/s. */
const PLAIN = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });

/** 3420 → „3,42 s“ */
export function seconds(ms: number): string {
  return `${DECIMAL.format(ms / 1000)} s`;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${SHORT_DECIMAL.format(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  const rest = Math.round((ms % 60_000) / 1000);
  return `${minutes}:${String(rest).padStart(2, "0")} min`;
}

const STATUS_LABEL: Record<TestStatus, string> = {
  passed: "[OK]     ",
  failed: "[FEHLER] ",
  timedOut: "[ZEIT]   ",
  skipped: "[--]     ",
  interrupted: "[ABBRUCH]",
};

const RESULT_LABEL: Record<SmokeReport["status"], string> = {
  passed: "BESTANDEN",
  failed: "NICHT BESTANDEN",
  timedout: "NICHT BESTANDEN (Zeitlimit)",
  interrupted: "ABGEBROCHEN",
};

function verdict(ok: boolean): string {
  return ok ? "OK" : "VERFEHLT";
}

function coldStartLines(cold: ColdStartResult): string[] {
  const { throttling } = cold;
  const lines = [
    `Kaltstart (Slow 4G: ${throttling.latencyMs} ms, ${PLAIN.format(throttling.downloadKbitPerSecond / 1000)}/` +
      `${PLAIN.format(throttling.uploadKbitPerSecond / 1000)} Mbit/s, CPU ${throttling.cpuSlowdown}×; ohne Cache ` +
      "und Service Worker)",
    `  Öffnen → Lobby sichtbar  ${seconds(cold.openToLobbyMs).padEnd(8)}  Ziel < ${PLAIN.format(cold.sloMs / 1000)} s (docs/01)  ` +
      verdict(cold.openToLobbyMs < cold.sloMs),
  ];
  if (cold.lcpMs !== null) {
    lines.push(
      `  LCP Startseite           ${seconds(cold.lcpMs).padEnd(8)}  Ziel < ${PLAIN.format(cold.lcpSloMs / 1000)} s (docs/07)  ` +
        verdict(cold.lcpMs < cold.lcpSloMs),
    );
  } else {
    lines.push("  LCP Startseite           nicht gemessen");
  }
  const details = [
    cold.ttfbMs === null ? null : `TTFB ${seconds(cold.ttfbMs)}`,
    cold.fcpMs === null ? null : `FCP ${seconds(cold.fcpMs)}`,
    `bedienbar ${seconds(cold.interactiveMs)} (${cold.transferredKb} KB)`,
    cold.createToLobbyMs === null ? null : `Klick → Lobby ${seconds(cold.createToLobbyMs)}`,
  ].filter((part): part is string => part !== null);
  lines.push(`  ${details.join(" · ")}`);
  return lines;
}

function gameLines(game: GameSection): string[] {
  const people = game.players.map((player) => `${player.name} (${player.device}${player.host ? ", Host" : ""})`);
  if (!game.played) {
    return [
      "Spiel",
      `  Lobby ${game.code}: ${people.join(" und ")} – kein Spiel (${game.skipReason ?? "nicht gestartet, siehe Fehler"})`,
    ];
  }
  const outcome = game.players.map(
    (player) =>
      `${player.name}: ${player.finished ? (player.headline ?? "Spielende") : "kein Spielende"} ` +
      `(${player.picks} Wahl, ${player.answers} Antworten${player.missedAnswers > 0 ? `, ${player.missedAnswers} verpasst` : ""})`,
  );
  const left = game.players.every((player) => player.left)
    ? "beide haben die Lobby verlassen"
    : "Lobby nicht verlassen";
  return [
    "Spiel",
    `  Lobby ${game.code}: ${people.join(" und ")}, ${game.rounds} Runde × ${game.questionsPerCategory} Frage je Kategorie`,
    `  Start → Spielende ${game.durationMs === null ? "–" : seconds(game.durationMs)}; ${outcome.join("; ")}; ${left}`,
  ];
}

function list(items: readonly string[], limit = 10): string[] {
  const shown = items.slice(0, limit).map((item) => `    - ${item}`);
  if (items.length > limit) shown.push(`    … und ${items.length - limit} weitere (siehe JSON)`);
  return shown;
}

/** Kurzfassung für Konsole und `smoke-report.txt`. */
export function formatSmokeReport(report: SmokeReport): string {
  const passed = report.checks.filter((check) => check.status === "passed").length;
  const lines: string[] = [
    `quizmaster Smoke-Test: ${RESULT_LABEL[report.status]} – ${passed}/${report.checks.length} Prüfungen in ` +
      duration(report.durationMs),
    `Ziel: ${report.baseUrl}${report.resolveTo ? ` (Host aufgelöst auf ${report.resolveTo}, Zertifikatsfehler ignoriert)` : ""}`,
    `Lauf: ${report.startedAt} bis ${report.finishedAt}${report.play ? "" : " · ohne Spiel (SMOKE_PLAY=0)"}`,
    "",
    "Prüfungen",
  ];
  for (const check of report.checks) {
    lines.push(`  ${STATUS_LABEL[check.status]} ${check.title} (${duration(check.durationMs)})`);
    for (const error of check.errors.slice(0, 3)) {
      const excerpt = error
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(0, 4);
      for (const line of excerpt) lines.push(`             ${line.trim()}`);
    }
  }
  for (const error of report.globalErrors) lines.push(`  [FEHLER]  ${error.split("\n")[0] ?? error}`);

  if (report.coldStart) lines.push("", ...coldStartLines(report.coldStart));
  if (report.game) lines.push("", ...gameLines(report.game));

  const { browser } = report;
  lines.push(
    "",
    "Browser (alle Seiten, gesamter Lauf)",
    `  ${browser.cspViolations.length} CSP-Verstöße · ${browser.consoleErrors.length} Konsolenfehler · ` +
      `${browser.pageErrors.length} Seitenfehler · ${browser.crashes.length} Abstürze (${browser.messages} Konsolenmeldungen protokolliert)`,
    ...list([...browser.cspViolations, ...browser.consoleErrors, ...browser.pageErrors, ...browser.crashes]),
  );

  if (report.axe.length > 0) {
    lines.push(
      "",
      "axe (WCAG 2.2 AA + Best Practices) je Screen: Befunde",
      `  ${report.axe.map((entry) => `${entry.screen} (${entry.device}) ${entry.violations.length}`).join(" · ")}`,
      ...list(
        report.axe.flatMap((entry) => [
          ...entry.violations.map((finding) => `${entry.screen}: ${finding.id} (${finding.impact}) – ${finding.help}`),
          ...entry.layout.map((problem) => `${entry.screen}: ${problem}`),
        ]),
      ),
    );
  }

  if (report.pwa) {
    const { pwa } = report;
    const reachableIcons = pwa.manifest.icons.filter((icon) => icon.status === 200).length;
    lines.push(
      "",
      "PWA",
      `  ${pwa.installabilityErrors.length === 0 ? "installierbar laut Chromium" : `${pwa.installabilityErrors.length} Einwände von Chromium`}` +
        ` · Manifest ${pwa.manifest.status} (${pwa.manifestErrors.length} Parser-Meldungen, ${reachableIcons}/${pwa.manifest.icons.length} Icons erreichbar)` +
        ` · Service Worker ${pwa.serviceWorker.state || "fehlt"}${pwa.serviceWorker.controlling ? ", steuert die Seite" : ""}`,
      ...list([...pwa.installabilityErrors, ...pwa.manifestErrors]),
    );
  }

  if (report.headers) {
    const failed = report.headers.checks.filter((check) => !check.ok);
    lines.push(
      "",
      `Sicherheits-Header der Startseite: ${report.headers.checks.length - failed.length}/${report.headers.checks.length} erfüllt`,
      ...list(
        failed.map((check) => `${check.label}: erwartet ${check.expected}, gefunden ${check.actual ?? "(fehlt)"}`),
      ),
    );
  }

  lines.push("");
  const { cleanup } = report;
  if (cleanup.commands.length > 0) {
    lines.push(
      `Bereinigung der Testspiele (Lobby ${cleanup.lobbyCodes.join(", ")}; zuerst mit --dry-run prüfen):`,
      ...cleanup.commands.map((command) => `  ${command}`),
    );
  } else if (cleanup.lobbyCodes.length > 0) {
    lines.push(`Bereinigung: nichts zu tun – kein Spiel gestartet (Lobby ${cleanup.lobbyCodes.join(", ")}).`);
  } else {
    lines.push("Bereinigung: keine Lobby angelegt.");
  }
  lines.push(
    "",
    `Bericht: ${report.files.json}`,
    `Artefakte: ${report.files.artifacts} · HTML-Bericht mit Traces bei Fehlern: ${report.files.html}`,
  );
  return `${lines.join("\n")}\n`;
}
