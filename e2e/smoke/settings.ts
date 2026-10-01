/**
 * Einstellungen des Smoke-Tests gegen eine laufende Instanz (README „Smoke-Test gegen eine laufende Instanz“):
 * aus der Umgebung gelesen und geprüft, bevor Playwright einen Browser startet.
 *
 * - `SMOKE_BASE_URL` (Pflicht): Origin der Instanz, `http(s)://host[:port]` ohne Pfad.
 * - `SMOKE_RESOLVE_TO` (optional): IP-Adresse, auf die Chromium den Host auflöst (`--host-resolver-rules`) – Test
 *   direkt über den Origin mit Cloudflare-Origin-Zertifikat. Nur dann werden Zertifikatsfehler ignoriert.
 * - `SMOKE_OUTPUT` (optional): Ordner für Bericht und Artefakte, Standard `e2e/smoke-results`; relative Pfade
 *   gelten ab dem Verzeichnis, in dem der Befehl aufgerufen wurde.
 * - `SMOKE_PLAY=0` (optional): ohne Spiel (Kaltstart, Beitritt, Lobby und Verlassen laufen trotzdem).
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join, resolve } from "node:path";

/** Markierung eines Smoke-Ausgabeordners: Nur so markierte (oder neue, leere) Ordner nutzt der Smoke-Test. */
export const OUTPUT_MARKER = ".quizmaster-smoke";

/** Unterordner im Ausgabeordner, die Playwright bei jedem Lauf leert. */
export const ARTIFACTS_SUBDIR = "artifacts";
export const HTML_REPORT_SUBDIR = "html";

export const USAGE =
  "Aufruf: SMOKE_BASE_URL=https://<domain> [SMOKE_RESOLVE_TO=<ip>] [SMOKE_OUTPUT=<ordner>] [SMOKE_PLAY=0] pnpm --filter e2e test:smoke";

export interface SmokeSettings {
  /** Origin der Instanz, z. B. `https://quizmaster.dev-sven.de` */
  baseUrl: string;
  /** Hostname aus `baseUrl` (ohne Port, IPv6 ohne Klammern) */
  hostname: string;
  https: boolean;
  /** IP, auf die Chromium den Host auflöst (Test über den Origin), sonst `null` */
  resolveTo: string | null;
  /** Ordner für Bericht und Artefakte (absolut) */
  outputDir: string;
  /** `false` bei `SMOKE_PLAY=0` */
  play: boolean;
}

export interface SmokeSettingsDefaults {
  /** Standard-Ausgabeordner (absolut) */
  outputDir: string;
  /** Basis für relative `SMOKE_OUTPUT` (Aufrufverzeichnis) */
  cwd: string;
}

export type SmokeEnv = Readonly<Record<string, string | undefined>>;

/** Ungültige oder fehlende Einstellung – die Meldung nennt nur Schlüssel und Regel, nie eingegebene Werte. */
export class SmokeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeSettingsError";
  }
}

/** `SMOKE_PLAY`: leer/`1` = mit Spiel, `0` = ohne; alles andere ist ein Tippfehler. */
export function isPlayEnabled(env: SmokeEnv): boolean {
  const raw = env.SMOKE_PLAY?.trim() ?? "";
  if (raw === "" || raw === "1") return true;
  if (raw === "0") return false;
  throw new SmokeSettingsError("SMOKE_PLAY darf nur 0 (ohne Spiel) oder 1 (Standard) sein");
}

function parseBaseUrl(env: SmokeEnv): URL {
  const raw = env.SMOKE_BASE_URL?.trim() ?? "";
  if (raw === "") throw new SmokeSettingsError("SMOKE_BASE_URL fehlt (Origin der laufenden Instanz, http oder https)");
  if (!URL.canParse(raw)) throw new SmokeSettingsError("SMOKE_BASE_URL ist keine gültige URL");
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SmokeSettingsError("SMOKE_BASE_URL muss mit http:// oder https:// beginnen");
  }
  if (url.username !== "" || url.password !== "") {
    throw new SmokeSettingsError("SMOKE_BASE_URL darf keine Zugangsdaten enthalten");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new SmokeSettingsError("SMOKE_BASE_URL nur als Origin ohne Pfad, Query oder Fragment angeben");
  }
  return url;
}

/** Hostname ohne die Klammern einer IPv6-Adresse. */
function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, "$1");
}

/** Liest und prüft alle Einstellungen (rein, ohne Dateizugriffe). */
export function parseSmokeSettings(env: SmokeEnv, defaults: SmokeSettingsDefaults): SmokeSettings {
  const url = parseBaseUrl(env);
  const hostname = bareHostname(url);
  const rawResolve = env.SMOKE_RESOLVE_TO?.trim() ?? "";
  let resolveTo: string | null = null;
  if (rawResolve !== "") {
    if (isIP(rawResolve) === 0)
      throw new SmokeSettingsError("SMOKE_RESOLVE_TO muss eine IP-Adresse sein (z. B. 127.0.0.1)");
    if (isIP(hostname) !== 0) {
      throw new SmokeSettingsError("SMOKE_RESOLVE_TO braucht in SMOKE_BASE_URL einen Hostnamen statt einer IP-Adresse");
    }
    resolveTo = rawResolve;
  }
  const rawOutput = env.SMOKE_OUTPUT?.trim() ?? "";
  return {
    baseUrl: url.origin,
    hostname,
    https: url.protocol === "https:",
    resolveTo,
    outputDir: rawOutput === "" ? defaults.outputDir : resolve(defaults.cwd, rawOutput),
    play: isPlayEnabled(env),
  };
}

/**
 * Chromium-Argumente: Mit `SMOKE_RESOLVE_TO` löst Chromium den Host auf diese IP auf (auch für WebSockets) und
 * ignoriert Zertifikatsfehler auch beim Laden des Service Workers – das Kontext-Flag `ignoreHTTPSErrors` allein
 * deckt die Registrierung des Service Workers nicht ab.
 */
export function chromiumArgs(settings: Pick<SmokeSettings, "hostname" | "resolveTo">): string[] {
  if (settings.resolveTo === null) return [];
  const target = isIP(settings.resolveTo) === 6 ? `[${settings.resolveTo}]` : settings.resolveTo;
  return [`--host-resolver-rules=MAP ${settings.hostname} ${target}`, "--ignore-certificate-errors"];
}

/**
 * Legt den Ausgabeordner an bzw. prüft ihn: Playwright leert bei jedem Lauf `artifacts/` und `html/` darin.
 * Deshalb nur ein neuer, leerer oder bereits markierter Ordner – nie ein Ordner mit fremdem Inhalt. Die
 * Markierung und eine `.gitignore` mit `*` halten Bericht und Artefakte aus jedem Git-Repo heraus.
 */
export function prepareOutputDir(dir: string): void {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new SmokeSettingsError(`SMOKE_OUTPUT ist kein Ordner: ${dir}`);
    const entries = readdirSync(dir);
    if (entries.length > 0 && !entries.includes(OUTPUT_MARKER)) {
      throw new SmokeSettingsError(
        `SMOKE_OUTPUT zeigt auf einen Ordner mit fremdem Inhalt (${dir}) – bitte einen neuen oder leeren Ordner wählen`,
      );
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, OUTPUT_MARKER), "Ausgabe des quizmaster-Smoke-Tests (e2e/playwright.smoke.config.ts)\n");
  writeFileSync(join(dir, ".gitignore"), "# Bericht und Artefakte des Smoke-Tests – nie committen\n*\n");
}
