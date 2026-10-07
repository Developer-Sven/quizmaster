// Bundle-Budgets (docs/07 §SLOs, docs/11 §CI Schritt 4): initiales JS (gzip -9) je Route aus einem
// Produktions-Build; Abbruch (Exit 1), wenn eine Route ihr Budget überschreitet.
//
//   pnpm perf:budgets [--dist apps/web/.next] [--budget "/=160"] [--json <datei>]
//   pnpm perf:budgets --url http://127.0.0.1:3520 [--dist …]   # zusätzlich gegen das HTML einer laufenden Instanz
//
// --dist     Build-Ordner (Standard: apps/web/$NEXT_DIST_DIR bzw. apps/web/.next)
// --url      laufende Instanz (next start/standalone): misst die im HTML referenzierten Skripte und prüft, dass
//            sie mit der Build-Analyse übereinstimmen
// --budget   Budget einer Route überschreiben, z. B. "/=160" (Entscheidung per ADR, docs/14) – mehrfach möglich
// --json     Ergebnis als JSON (z. B. nach reports/)
//
// „Initial“ = Skripte im HTML ohne noModule = Framework (rootMainFiles) + Layout/Fehlergrenze/Seite der Route.
// Zusätzlich ausgewiesen: dynamische Importe der Seite; bei /lobby/[code] lädt LobbyEntry LobbyScreen sofort
// („beim Öffnen“) – das zählt nicht zum Budget, zeigt aber Ausreißer wie den zod-Locale-Chunk.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  BUDGETS,
  type BudgetVerdict,
  dynamicImportGroups,
  gzipSize,
  judge,
  KB,
  kb,
  measureFromBuild,
  measureFromHtml,
  pageEntryFiles,
  type RouteBudget,
  type RouteMeasurement,
  readBuildManifest,
  scriptsFromHtml,
} from "./lib/bundle.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const USAGE =
  'pnpm perf:budgets [--dist <build-ordner>] [--url <basis-url>] [--budget "<route>=<kb>"]… [--json <datei>]';

class UsageError extends Error {}

function parseBudgetOverrides(values: readonly string[]): Map<string, number> {
  const overrides = new Map<string, number>();
  for (const value of values) {
    const match = /^(\/[^=]*)=(\d+(?:[.,]\d+)?)$/.exec(value.trim());
    if (match?.[1] === undefined || match[2] === undefined)
      throw new UsageError(`--budget "${value}": "<route>=<kb>" erwartet`);
    if (!BUDGETS.some((budget) => budget.route === match[1]))
      throw new UsageError(`--budget: unbekannte Route ${match[1]}`);
    overrides.set(match[1], Number(match[2].replace(",", ".")));
  }
  return overrides;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: "text/html", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200) throw new Error(`GET ${new URL(url).pathname}: HTTP ${response.status}`);
  return response.text();
}

async function measureLive(
  base: string,
  budget: RouteBudget,
  dist: string | undefined,
): Promise<{ measurement: RouteMeasurement; chunkCache: Map<string, Buffer> }> {
  const html = await fetchText(new URL(budget.samplePath, base).href);
  const cache = new Map<string, Buffer>();
  const load = async (file: string) => {
    if (!cache.has(file)) {
      const response = await fetch(new URL(`/_next/${file}`, base).href, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`GET /_next/${file}: HTTP ${response.status}`);
      cache.set(file, Buffer.from(await response.arrayBuffer()));
    }
    return cache.get(file) as Buffer;
  };
  const framework = dist === undefined ? [] : readBuildManifest(dist).rootMainFiles;
  const pageFiles = dist === undefined ? undefined : pageEntryFiles(dist, budget.route);
  // Alle möglicherweise gebrauchten Chunks vorab laden; die Messung selbst ist synchron.
  for (const file of scriptsFromHtml(html)) await load(file);
  for (const file of pageFiles ?? scriptsFromHtml(html)) {
    const source = (await load(file)).toString("utf8");
    for (const group of dynamicImportGroups(source)) for (const chunk of group) await load(chunk);
  }
  const measurement = measureFromHtml(
    budget.route,
    html,
    framework,
    (file) => gzipSize(cache.get(file) ?? Buffer.alloc(0)),
    (file) => (cache.get(file) ?? Buffer.alloc(0)).toString("utf8"),
    pageFiles,
  );
  return { measurement, chunkCache: cache };
}

function printTable(title: string, verdicts: readonly BudgetVerdict[]): void {
  console.info(`\n${title}`);
  console.info("Route            initial (gzip)  davon Framework  Budget            beim Öffnen  Status");
  for (const verdict of verdicts) {
    const { budget, measurement } = verdict;
    const limit = budget.maxKb === null ? "–" : `${kb(budget.maxKb * KB)} KB (${budget.source})`;
    const onOpen = budget.eagerDynamic ? `${kb(verdict.onOpenBytes)} KB` : "–";
    const status = budget.maxKb === null ? "Bericht" : verdict.ok ? "ok" : "ÜBERSCHRITTEN";
    console.info(
      `${budget.route.padEnd(16)} ${`${kb(measurement.initialBytes)} KB`.padStart(14)}  ${`${kb(measurement.frameworkBytes)} KB`.padStart(15)}  ${limit.padEnd(16)}  ${onOpen.padStart(11)}  ${status}`,
    );
    for (const group of measurement.dynamicGroups) {
      console.info(`  dynamischer Import: ${kb(group.bytes)} KB in ${group.files.length} Chunks`);
    }
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      dist: { type: "string" },
      url: { type: "string" },
      budget: { type: "string", multiple: true },
      json: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.info(`Aufruf: ${USAGE}`);
    return 0;
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const absolute = (path: string) => (isAbsolute(path) ? path : resolve(cwd, path));
  const overrides = parseBudgetOverrides(values.budget ?? []);
  const budgets = BUDGETS.map((budget) => {
    const override = overrides.get(budget.route);
    return override === undefined
      ? budget
      : { ...budget, maxKb: override, source: `--budget (docs/07: ${budget.maxKb ?? "–"} KB)` };
  });

  const defaultDist = join(REPO_ROOT, "apps", "web", process.env.NEXT_DIST_DIR ?? ".next");
  const dist = values.dist === undefined ? (values.url === undefined ? defaultDist : undefined) : absolute(values.dist);

  const results: { source: string; verdicts: BudgetVerdict[] }[] = [];
  if (dist !== undefined) {
    const verdicts = budgets.map((budget) => judge(budget, measureFromBuild(dist, budget.route)));
    printTable(`Build-Analyse (${dist})`, verdicts);
    results.push({ source: "build", verdicts });
  }
  if (values.url !== undefined) {
    const base = values.url;
    const verdicts: BudgetVerdict[] = [];
    for (const budget of budgets) verdicts.push(judge(budget, (await measureLive(base, budget, dist)).measurement));
    printTable(`HTML-Analyse (${new URL(base).origin})`, verdicts);
    results.push({ source: "html", verdicts });
    const build = results.find((result) => result.source === "build");
    if (build !== undefined) {
      for (const verdict of verdicts) {
        const fromBuild = build.verdicts.find((entry) => entry.budget.route === verdict.budget.route);
        const a = fromBuild?.measurement.files.join(",");
        const b = verdict.measurement.files.join(",");
        if (a !== b) {
          console.error(`\nAbweichung bei ${verdict.budget.route}: Build und HTML referenzieren verschiedene Chunks`);
          console.error(
            `  nur Build: ${fromBuild?.measurement.files.filter((file) => !verdict.measurement.files.includes(file)).join(", ")}`,
          );
          console.error(
            `  nur HTML:  ${verdict.measurement.files.filter((file) => !fromBuild?.measurement.files.includes(file)).join(", ")}`,
          );
          return 1;
        }
      }
      console.info("\nBuild- und HTML-Analyse stimmen überein (gleiche Chunks je Route).");
    }
  }

  if (values.json !== undefined) {
    const target = absolute(values.json);
    mkdirSync(dirname(target), { recursive: true });
    const json = results.map((result) => ({
      source: result.source,
      routes: result.verdicts.map((verdict) => ({
        route: verdict.budget.route,
        budgetKb: verdict.budget.maxKb,
        budgetSource: verdict.budget.source,
        initialBytes: verdict.measurement.initialBytes,
        frameworkBytes: verdict.measurement.frameworkBytes,
        onOpenBytes: verdict.budget.eagerDynamic ? verdict.onOpenBytes : null,
        dynamicImports: verdict.measurement.dynamicGroups.map((group) => ({
          bytes: group.bytes,
          chunks: group.files.length,
        })),
        files: verdict.measurement.files,
        ok: verdict.ok,
      })),
    }));
    writeFileSync(target, `${JSON.stringify({ measuredAt: new Date().toISOString(), results: json }, null, 2)}\n`);
    console.info(`\nErgebnis: ${target}`);
  }

  const failed = results.flatMap((result) => result.verdicts.filter((verdict) => !verdict.ok));
  if (failed.length > 0) {
    for (const verdict of failed) {
      console.error(
        `Budget überschritten: ${verdict.budget.route} ${kb(verdict.measurement.initialBytes)} KB > ${kb((verdict.budget.maxKb ?? 0) * KB)} KB (${verdict.budget.source})`,
      );
    }
    return 1;
  }
  console.info("\nAlle Budgets eingehalten.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`perf:budgets – ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof UsageError) console.error(`Aufruf: ${USAGE}`);
    process.exit(2);
  },
);
