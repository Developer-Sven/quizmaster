/**
 * Bundle-Analyse für die Budgets aus docs/07 (§SLOs „JS initial“): Welche Chunks lädt eine Route beim ersten
 * Aufruf, und wie groß sind sie gzip-komprimiert? Zwei gleichwertige Quellen:
 *
 * - **Build-Ausgabe** (CI, ohne Server): `build-manifest.json` (`rootMainFiles` = Framework: React DOM, App-Router,
 *   Turbopack-Laufzeit) plus `entryJSFiles` der Segmente auf dem Weg zur Seite aus dem
 *   `page_client-reference-manifest.js` der Route (Layouts, Fehlergrenzen `error`, die Seite selbst). `not-found`
 *   und `global-error` lädt der Client nur im Fehlerfall.
 * - **HTML** einer laufenden Instanz: alle `<script src="/_next/…">` ohne `noModule` (Polyfills nur für alte
 *   Browser). `pnpm perf:budgets --url …` vergleicht beide Wege; sie müssen übereinstimmen.
 *
 * Zusätzlich die dynamischen Importe der Seite (`import()`/`next/dynamic`, im Chunk als Liste von Chunk-Pfaden):
 * `/lobby/[code]` lädt LobbyScreen sofort nach dem Hydrieren nach – das zählt nicht zu „initial“, wird aber als
 * „beim Öffnen“ ausgewiesen (dort steckte einmal der zod-Locale-Ausreißer).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** Budget einer Route in KB (1 KB = 1.024 Byte, gzip -9). */
export interface RouteBudget {
  route: string;
  /** Höchstwert „initial“ (HTML-Skripte); `null` = nur berichten. */
  maxKb: number | null;
  /** Herkunft des Werts (Spezifikation). */
  source: string;
  /** Ein Beispielpfad für die HTML-Messung. */
  samplePath: string;
  /** Lädt die Seite ihre dynamischen Importe direkt beim Öffnen (z. B. LobbyEntry → LobbyScreen)? */
  eagerDynamic: boolean;
}

/** Budgets laut docs/07 §SLOs (Abweichungen nur per ADR, docs/14). */
export const BUDGETS: readonly RouteBudget[] = [
  // docs/07 nannte 120 KB; Next 16 + React 19 bringen allein ≈ 127 KB mit (ADR-037).
  { route: "/", maxKb: 165, source: "ADR-037", samplePath: "/", eagerDynamic: false },
  {
    route: "/lobby/[code]",
    maxKb: 180,
    source: "docs/07",
    samplePath: "/lobby/ABC234",
    eagerDynamic: true,
  },
  { route: "/j/[code]", maxKb: null, source: "nur Bericht", samplePath: "/j/ABC234", eagerDynamic: false },
];

export const KB = 1_024;

export function gzipSize(content: Buffer | string): number {
  return gzipSync(content, { level: 9 }).length;
}

export interface BuildManifest {
  rootMainFiles: string[];
  polyfillFiles: string[];
}

export function readBuildManifest(dist: string): BuildManifest {
  const file = join(dist, "build-manifest.json");
  if (!existsSync(file)) throw new Error(`${file} fehlt – erst bauen (pnpm build)`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<BuildManifest>;
  if (!Array.isArray(parsed.rootMainFiles)) throw new Error("build-manifest.json ohne rootMainFiles");
  return { rootMainFiles: parsed.rootMainFiles, polyfillFiles: parsed.polyfillFiles ?? [] };
}

/** `entryJSFiles` aus `page_client-reference-manifest.js` (als JSON gelesen, nicht ausgeführt). */
export function parseClientReferenceManifest(source: string): Record<string, string[]> {
  const match = /globalThis\.__RSC_MANIFEST\[("(?:[^"\\]|\\.)*")\]\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(source.trim());
  if (match?.[2] === undefined) throw new Error("Client-Reference-Manifest nicht lesbar");
  const manifest = JSON.parse(match[2]) as { entryJSFiles?: Record<string, string[]> };
  if (manifest.entryJSFiles === undefined) throw new Error("Client-Reference-Manifest ohne entryJSFiles");
  return manifest.entryJSFiles;
}

/** `/lobby/[code]` → `lobby/[code]`; `/` → `""`. */
function routeDir(route: string): string {
  return route.replace(/^\/+|\/+$/g, "");
}

export function clientManifestPath(dist: string, route: string): string {
  const dir = routeDir(route);
  return join(dist, "server", "app", dir, "page_client-reference-manifest.js");
}

/** Segment-Einträge, die der Client beim ersten Aufruf lädt: Layouts, Templates und Fehlergrenzen auf dem Weg, die Seite. */
export function isInitialEntry(entryKey: string, route: string): boolean {
  const app = /\/app\/(.*)$/.exec(entryKey)?.[1];
  if (app === undefined) return false;
  const dir = routeDir(route);
  if (app === (dir === "" ? "page" : `${dir}/page`)) return true;
  const slash = app.lastIndexOf("/");
  const segment = slash === -1 ? "" : app.slice(0, slash);
  const kind = slash === -1 ? app : app.slice(slash + 1);
  if (!["layout", "template", "error", "loading"].includes(kind)) return false;
  return segment === "" || dir === segment || dir.startsWith(`${segment}/`);
}

/** Chunk-Pfade dynamischer Importe in einem Chunk (Turbopack: `["static/chunks/a.js", …].map(t => e.l(t))`). */
export function dynamicImportGroups(chunkSource: string): string[][] {
  const groups: string[][] = [];
  for (const match of chunkSource.matchAll(/\[((?:"static\/chunks\/[^"]+\.js",?)+)\]\.map\(/g)) {
    const list = match[1];
    if (list === undefined) continue;
    groups.push([...list.matchAll(/"(static\/chunks\/[^"]+\.js)"/g)].flatMap((entry) => (entry[1] ? [entry[1]] : [])));
  }
  return groups;
}

/** Skripte im HTML (ohne `noModule`), als Pfade relativ zu `/_next/` wie im Build-Manifest. */
export function scriptsFromHtml(html: string): string[] {
  const scripts: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    if (/\bnomodule\b/i.test(attrs)) continue;
    const src = /\bsrc="([^"]+)"/i.exec(attrs)?.[1];
    if (src === undefined) continue;
    const path = src.replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? "";
    if (path.startsWith("/_next/")) scripts.push(path.slice("/_next/".length));
  }
  return [...new Set(scripts)];
}

export interface RouteMeasurement {
  route: string;
  /** Initiale Chunks (relativ zu `/_next/` bzw. zum Build-Ordner). */
  files: string[];
  initialBytes: number;
  /** Davon Framework (`rootMainFiles`). */
  frameworkBytes: number;
  /** Dynamische Importe der Seite (Gruppen, ohne bereits initial geladene Chunks). */
  dynamicGroups: { files: string[]; bytes: number }[];
}

export type ChunkSize = (file: string) => number;
export type ChunkSource = (file: string) => string;

/** Misst eine Route aus der Build-Ausgabe. */
export function measureFromBuild(
  dist: string,
  route: string,
  size: ChunkSize = (file) => gzipSize(readFileSync(join(dist, file))),
  source: ChunkSource = (file) => readFileSync(join(dist, file), "utf8"),
): RouteMeasurement {
  const build = readBuildManifest(dist);
  const entries = parseClientReferenceManifest(readFileSync(clientManifestPath(dist, route), "utf8"));
  const files = new Set(build.rootMainFiles);
  for (const [key, list] of Object.entries(entries)) {
    if (!isInitialEntry(key, route)) continue;
    for (const file of list) files.add(file.replace(/^\/?_next\//, ""));
  }
  return summarize(route, [...files], build.rootMainFiles, pageEntryFiles(dist, route), size, source);
}

/** Chunks des Seiten-Eintrags einer Route (Quelle der dynamischen Importe der Seite). */
export function pageEntryFiles(dist: string, route: string): Set<string> {
  const entries = parseClientReferenceManifest(readFileSync(clientManifestPath(dist, route), "utf8"));
  const pageKey = routeDir(route) === "" ? "/app/page" : `/app/${routeDir(route)}/page`;
  const files = new Set<string>();
  for (const [key, list] of Object.entries(entries)) {
    if (key.endsWith(pageKey)) for (const file of list) files.add(file.replace(/^\/?_next\//, ""));
  }
  return files;
}

/**
 * Misst eine Route aus dem HTML (Skripte) – `size`/`source` holen die Chunks (z. B. per HTTP). Die dynamischen
 * Importe stammen aus `pageFiles` (Seiten-Eintrag laut Build); ohne Build aus allen Nicht-Framework-Chunks.
 */
export function measureFromHtml(
  route: string,
  html: string,
  frameworkFiles: readonly string[],
  size: ChunkSize,
  source: ChunkSource,
  pageFiles?: ReadonlySet<string>,
): RouteMeasurement {
  const files = scriptsFromHtml(html);
  const framework = new Set(frameworkFiles);
  const fallback = new Set(files.filter((file) => !framework.has(file)));
  return summarize(route, files, frameworkFiles, pageFiles ?? fallback, size, source);
}

function summarize(
  route: string,
  files: string[],
  frameworkFiles: readonly string[],
  pageFiles: ReadonlySet<string>,
  size: ChunkSize,
  source: ChunkSource,
): RouteMeasurement {
  const initial = new Set(files);
  const framework = new Set(frameworkFiles);
  let initialBytes = 0;
  let frameworkBytes = 0;
  for (const file of initial) {
    const bytes = size(file);
    initialBytes += bytes;
    if (framework.has(file)) frameworkBytes += bytes;
  }
  const seen = new Set<string>();
  const dynamicGroups: RouteMeasurement["dynamicGroups"] = [];
  for (const file of pageFiles) {
    for (const group of dynamicImportGroups(source(file))) {
      const fresh = group.filter((chunk) => !initial.has(chunk));
      const key = fresh.join("|");
      if (fresh.length === 0 || seen.has(key)) continue;
      seen.add(key);
      dynamicGroups.push({ files: fresh, bytes: fresh.reduce((sum, chunk) => sum + size(chunk), 0) });
    }
  }
  return { route, files: [...initial].sort(), initialBytes, frameworkBytes, dynamicGroups };
}

export interface BudgetVerdict {
  budget: RouteBudget;
  measurement: RouteMeasurement;
  /** Initial + dynamische Importe, die beim Öffnen sofort laden (nur `eagerDynamic`). */
  onOpenBytes: number;
  ok: boolean;
}

export function judge(budget: RouteBudget, measurement: RouteMeasurement): BudgetVerdict {
  const eager = budget.eagerDynamic ? measurement.dynamicGroups.reduce((sum, group) => sum + group.bytes, 0) : 0;
  const ok = budget.maxKb === null || measurement.initialBytes <= budget.maxKb * KB;
  return { budget, measurement, onOpenBytes: measurement.initialBytes + eager, ok };
}

export const kb = (bytes: number) => (bytes / KB).toFixed(1).replace(".", ",");
