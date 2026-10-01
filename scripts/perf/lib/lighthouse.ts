/**
 * Lighthouse-Hilfen (docs/07 §SLOs „Lighthouse mobil: Performance ≥ 90, A11y ≥ 95, Best Practices ≥ 95“, ADR-027:
 * LCP, CLS und TBT als Labor-Ersatz für Web Vitals, ADR-031: `lighthouse` 13.5 direkt statt @lhci/cli).
 * Rein bzw. ohne Netz: Chromium finden, Argumente bauen, Berichte auswerten, Mediane bilden.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Mindestwerte (0–1) je Kategorie. */
export const LIGHTHOUSE_THRESHOLDS = { performance: 0.9, accessibility: 0.95, "best-practices": 0.95 } as const;
export type LighthouseCategory = keyof typeof LIGHTHOUSE_THRESHOLDS;
export const LIGHTHOUSE_CATEGORIES = Object.keys(LIGHTHOUSE_THRESHOLDS) as LighthouseCategory[];

/** Labor-Richtwerte aus docs/07 (Startseite LCP < 1,8 s, CLS < 0,05) – nur berichtet, Abbruch über die Scores. */
export const VITALS_TARGETS = { lcpMs: 1_800, cls: 0.05 } as const;

export interface LighthouseRun {
  page: string;
  url: string;
  scores: Record<LighthouseCategory, number | null>;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  speedIndexMs: number | null;
  finalUrl: string | null;
  runtimeError: string | null;
  warnings: string[];
  /** Audits mit Score < 1 in A11y/Best Practices (für die Fehlersuche). */
  failedAudits: string[];
  reportPath: string | null;
}

/**
 * Chromium für Lighthouse: `CHROME_PATH`, sonst die neueste Playwright-Installation unter
 * `PLAYWRIGHT_BROWSERS_PATH` (`chromium-<rev>/chrome-linux64/chrome`).
 */
export function findChromium(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env.CHROME_PATH !== undefined && existsSync(env.CHROME_PATH)) return env.CHROME_PATH;
  const root = env.PLAYWRIGHT_BROWSERS_PATH;
  if (root === undefined || !existsSync(root)) return null;
  const builds = readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const build of builds) {
    for (const dir of ["chrome-linux64", "chrome-linux"]) {
      const candidate = join(root, build, dir, "chrome");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** `host=ip` für `--host-resolver-rules` (nur Hostname und IP-Adresse, keine Sonderzeichen). */
export function parseResolve(raw: string): { host: string; ip: string } {
  const match = /^([a-z0-9.-]+)=([0-9a-f:.]+)$/i.exec(raw.trim());
  if (match?.[1] === undefined || match[2] === undefined) throw new Error(`--resolve "${raw}": host=ip erwartet`);
  const ip = match[2];
  const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) && ip.split(".").every((part) => Number(part) <= 255);
  const ipv6 = ip.includes(":") && /^[0-9a-f:]+$/i.test(ip);
  if (!ipv4 && !ipv6) throw new Error(`--resolve: ungültige IP ${ip}`);
  return { host: match[1].toLowerCase(), ip: ipv6 ? `[${ip}]` : ip };
}

export interface ChromeOptions {
  resolve: { host: string; ip: string } | null;
  insecure: boolean;
}

/** Chrome-Flags: headless (neu), ohne Sandbox (Root/Container), optional Host-Auflösung und Origin-Zertifikat. */
export function chromeFlags(options: ChromeOptions): string[] {
  const flags = ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"];
  if (options.resolve !== null) flags.push(`--host-resolver-rules=MAP ${options.resolve.host} ${options.resolve.ip}`);
  if (options.insecure) flags.push("--ignore-certificate-errors");
  return flags;
}

/**
 * Wert für `--chrome-flags`: Lighthouse zerlegt den String mit yargs-parser an Leerzeichen – Werte mit Leerzeichen
 * (`--host-resolver-rules=MAP host ip`) brauchen Anführungszeichen, sonst bleibt nur `MAP` übrig und die Messung läuft
 * am Origin vorbei über das öffentliche DNS.
 */
export function chromeFlagsArgument(flags: readonly string[]): string {
  return flags
    .map((flag) => {
      const separator = flag.indexOf("=");
      if (separator === -1 || !/\s/.test(flag)) return flag;
      return `${flag.slice(0, separator + 1)}"${flag.slice(separator + 1)}"`;
    })
    .join(" ");
}

/** Argumente für die Lighthouse-CLI (mobile Standard-Drosselung: simuliertes langsames 4G, Moto-G-Profil). */
export function lighthouseArgs(url: string, outputBase: string, options: ChromeOptions): string[] {
  return [
    url,
    "--output=json",
    "--output=html",
    `--output-path=${outputBase}`,
    `--only-categories=${LIGHTHOUSE_CATEGORIES.join(",")}`,
    `--chrome-flags=${chromeFlagsArgument(chromeFlags(options))}`,
    "--max-wait-for-load=45000",
    "--quiet",
  ];
}

interface RawReport {
  finalDisplayedUrl?: string;
  runtimeError?: { code?: string; message?: string };
  runWarnings?: string[];
  categories?: Record<string, { score?: number | null; auditRefs?: Array<{ id: string; weight?: number }> }>;
  audits?: Record<string, { numericValue?: number; score?: number | null; scoreDisplayMode?: string; title?: string }>;
}

/** Wertet einen Lighthouse-JSON-Bericht aus. */
export function parseReport(page: string, url: string, raw: unknown, reportPath: string | null): LighthouseRun {
  const report = (raw ?? {}) as RawReport;
  const audit = (id: string) => report.audits?.[id]?.numericValue ?? null;
  const scores = Object.fromEntries(
    LIGHTHOUSE_CATEGORIES.map((category) => [category, report.categories?.[category]?.score ?? null]),
  ) as Record<LighthouseCategory, number | null>;
  const failedAudits: string[] = [];
  for (const category of ["accessibility", "best-practices"] as const) {
    for (const ref of report.categories?.[category]?.auditRefs ?? []) {
      const entry = report.audits?.[ref.id];
      if (entry === undefined || (ref.weight ?? 0) === 0) continue;
      if (entry.scoreDisplayMode === "binary" || entry.scoreDisplayMode === "numeric") {
        if (typeof entry.score === "number" && entry.score < 1) failedAudits.push(`${category}: ${ref.id}`);
      }
    }
  }
  return {
    page,
    url,
    scores,
    lcpMs: audit("largest-contentful-paint"),
    cls: audit("cumulative-layout-shift"),
    tbtMs: audit("total-blocking-time"),
    fcpMs: audit("first-contentful-paint"),
    speedIndexMs: audit("speed-index"),
    finalUrl: report.finalDisplayedUrl ?? null,
    runtimeError: report.runtimeError?.code ?? null,
    warnings: report.runWarnings ?? [],
    failedAudits,
    reportPath,
  };
}

/** Median-Lauf je Seite (nach Performance-Score, wie Lighthouse CI). */
export function medianRun(runs: readonly LighthouseRun[]): LighthouseRun | null {
  const valid = runs.filter((run) => run.runtimeError === null && run.scores.performance !== null);
  if (valid.length === 0) return runs[0] ?? null;
  const sorted = [...valid].sort((a, b) => (a.scores.performance ?? 0) - (b.scores.performance ?? 0));
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/** Verstöße eines (Median-)Laufs gegen die Mindestwerte. */
export function violations(run: LighthouseRun): string[] {
  const problems: string[] = [];
  if (run.runtimeError !== null) problems.push(`${run.page}: Lighthouse-Fehler ${run.runtimeError}`);
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const score = run.scores[category];
    const min = LIGHTHOUSE_THRESHOLDS[category];
    if (score === null || score < min) {
      problems.push(
        `${run.page}: ${category} ${score === null ? "–" : Math.round(score * 100)} < ${Math.round(min * 100)}`,
      );
    }
  }
  return problems;
}
