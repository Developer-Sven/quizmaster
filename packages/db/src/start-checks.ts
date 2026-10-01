/**
 * Start-Checks (docs/02 §Start-Checks, fail fast): Transport (TLS mit Zertifikatsprüfung zu entfernten
 * Hosts, docs/04/06/12 „TLS erzwingen“ – geprüft VOR dem ersten Kommando, damit Zugangsdaten nie im Klartext
 * übers Netz gehen), Ping (5 s), Replica Set bzw. Sharded Cluster (Change Streams + Transaktionen),
 * Server-Version (≥ 8.0 empfohlen → sonst Warnung) und Patchstand (docs/03, docs/06 „Server-Version gepatcht
 * halten“: bekannte Server-Lücken wie CVE-2025-14847 „MongoBleed“ → Fehler-Log mit Ziel-Version, `env:check
 * --connect` bricht in Produktion ab). Der Start bricht dafür bewusst NICHT ab: Die Lücke liegt im Datenbankserver
 * und ist unabhängig davon ausnutzbar, ob die App verbunden ist – ein Abbruch brächte nur einen Ausfall.
 * `ensureIndexes()` ist ein eigener Schritt.
 */
import type { MongoClient } from "mongodb";
import { type ClientTransport, clientTransport, describeClientHosts } from "./client.ts";
import { type DbLogger, describeError, silentLogger } from "./logger.ts";

export const START_CHECK_PING_TIMEOUT_MS = 5_000;
export const RECOMMENDED_SERVER_MAJOR = 8;

export const START_CHECK_ERROR_CODES = ["TLS_REQUIRED", "PING_FAILED", "NO_REPLICA_SET", "SERVER_INFO_FAILED"] as const;
export type StartCheckErrorCode = (typeof START_CHECK_ERROR_CODES)[number];

/** Abbruchgrund beim Start – Nachricht enthält nie Zugangsdaten. */
export class StartCheckError extends Error {
  readonly code: StartCheckErrorCode;

  constructor(code: StartCheckErrorCode, message: string) {
    super(message);
    this.name = "StartCheckError";
    this.code = code;
  }
}

export interface StartCheckResult {
  serverVersion: string;
  topology: "replicaSet" | "sharded";
  /** Name des Replica Sets (bei Sharded Clusters `null`). */
  setName: string | null;
  /** false = Version < 8.0 (nur Warnung). */
  versionRecommended: boolean;
  /** Bekannte, auf diesem Server ungepatchte Lücken (`knownServerVulnerabilities`); `null` = Version unlesbar. */
  knownVulnerabilities: string[] | null;
  /** `insecure` nur mit `allowInsecureTransport` (Entwicklung). */
  transport: ClientTransport;
}

/** Sicherheitslücke des MongoDB-Servers mit der ersten gepatchten Version je Release-Linie. */
export interface ServerAdvisory {
  id: string;
  name: string;
  /** Erste gepatchte Version je Linie „major.minor“. */
  fixedIn: Readonly<Record<string, string>>;
  /** Ab dieser Linie („major.minor“) sind alle Versionen gepatcht; ältere Linien ohne `fixedIn`-Eintrag nie. */
  fixedSince: string;
}

/**
 * Bekannte Server-Lücken (docs/03, docs/06): CVE-2025-14847 „MongoBleed“ (Dez. 2025) – unauthentifiziertes Auslesen
 * von Heap-Speicher über zlib-komprimierte Nachrichten, aktiv ausgenutzt. Linien ohne Eintrag (z. B. die Rapid
 * Releases 8.1, 7.1–7.3 und alles vor 4.4) haben keine gepatchte Version.
 */
export const MONGODB_SERVER_ADVISORIES: readonly ServerAdvisory[] = Object.freeze([
  {
    id: "CVE-2025-14847",
    name: "MongoBleed",
    fixedIn: { "8.2": "8.2.3", "8.0": "8.0.17", "7.0": "7.0.28", "6.0": "6.0.27", "5.0": "5.0.32", "4.4": "4.4.30" },
    fixedSince: "8.3",
  },
]);

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Vorabversion (`-rc0`, `-alpha` …) – kleiner als die Version ohne Zusatz. */
  prerelease: boolean;
}

function parseServerVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined && /^(rc|alpha|beta)/i.test(match[4]),
  };
}

/** Vergleich zweier Versionen (negativ: `a` älter). */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || Number(b.prerelease) - Number(a.prerelease);
}

function isPatched(version: ParsedVersion, advisory: ServerAdvisory): boolean {
  const since = parseServerVersion(`${advisory.fixedSince}.0`);
  if (since !== null && compareVersions(version, since) >= 0) return true;
  const floor = advisory.fixedIn[`${version.major}.${version.minor}`];
  const parsedFloor = floor === undefined ? null : parseServerVersion(floor);
  return parsedFloor !== null && compareVersions(version, parsedFloor) >= 0;
}

/**
 * Bekannte Lücken, für die die Server-Version (`buildInfo.version`, z. B. „8.0.4“) zu alt ist – leer = gepatcht,
 * `null` = Version nicht auswertbar (dann selbst prüfen).
 */
export function knownServerVulnerabilities(version: string): string[] | null {
  const parsed = parseServerVersion(version);
  if (parsed === null) return null;
  return MONGODB_SERVER_ADVISORIES.filter((advisory) => !isPatched(parsed, advisory)).map(
    (advisory) => `${advisory.id} (${advisory.name})`,
  );
}

/** Ziel-Version für die Meldung: Patch der eigenen Linie, sonst die gepatchten Linien. */
export function patchTarget(version: string): string {
  const parsed = parseServerVersion(version);
  const lines = MONGODB_SERVER_ADVISORIES.filter((advisory) => parsed === null || !isPatched(parsed, advisory));
  const own = parsed === null ? [] : lines.map((advisory) => advisory.fixedIn[`${parsed.major}.${parsed.minor}`]);
  if (own.length > 0 && own.every((floor) => floor !== undefined)) {
    return `mindestens ${[...new Set(own)].join(" bzw. ")}`;
  }
  return "eine gepatchte Version (8.0 ≥ 8.0.17, 8.2 ≥ 8.2.3 oder ≥ 8.3)";
}

export interface StartCheckOptions {
  logger?: DbLogger;
  /** Ping-Frist (Standard 5 s). */
  pingTimeoutMs?: number;
  /**
   * NUR Entwicklung: Verbindung ohne geprüftes TLS zu entfernten Hosts erlauben (Warnung statt Abbruch).
   * Standard `false` (fail-closed); Produktion nie – dort verlangt zusätzlich `checkSourceRules` TLS.
   */
  allowInsecureTransport?: boolean;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Wartet höchstens `ms` auf `promise`. Beide Ausgänge werden behandelt – ein später scheiternder
 * Befehl erzeugt keine unbehandelte Promise-Ablehnung.
 */
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settled<T> | "timeout"> {
  const settled: Promise<Settled<T>> = promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Hauptversion aus einem Versions-String („8.0.4“ → 8), `NaN` wenn unlesbar. */
export function serverMajorVersion(version: string): number {
  const match = /^(\d+)\./.exec(version);
  return match ? Number(match[1]) : Number.NaN;
}

/**
 * Führt die Start-Checks aus und wirft `StartCheckError`, wenn der Dienst nicht starten darf.
 * Verbindet den Client bei Bedarf selbst.
 */
export async function runStartChecks(client: MongoClient, options: StartCheckOptions = {}): Promise<StartCheckResult> {
  const logger = options.logger ?? silentLogger;
  const pingTimeoutMs = options.pingTimeoutMs ?? START_CHECK_PING_TIMEOUT_MS;
  const target = describeClientHosts(client);

  const transport = clientTransport(client);
  if (transport === "insecure") {
    const message =
      `Verbindung zu ${target} ohne (geprüftes) TLS – Zugangsdaten und Daten wären im Netz lesbar ` +
      "(tls=true bzw. mongodb+srv://, ohne tlsInsecure/tlsAllowInvalid*)";
    if (options.allowInsecureTransport !== true) throw new StartCheckError("TLS_REQUIRED", message);
    logger.warn(`WARNUNG (nur Entwicklung erlaubt): ${message}`);
  }

  const admin = client.db("admin");

  const ping = await settleWithin(admin.command({ ping: 1 }), pingTimeoutMs);
  if (ping === "timeout") {
    throw new StartCheckError("PING_FAILED", `MongoDB antwortet nicht innerhalb von ${pingTimeoutMs} ms (${target})`);
  }
  if (!ping.ok) {
    throw new StartCheckError("PING_FAILED", `MongoDB nicht erreichbar (${target}): ${describeError(ping.error)}`);
  }

  let hello: { setName?: unknown; msg?: unknown };
  let version: string;
  try {
    hello = await admin.command({ hello: 1 });
    const buildInfo = await admin.command({ buildInfo: 1 });
    version = typeof buildInfo.version === "string" ? buildInfo.version : "unbekannt";
  } catch (error) {
    throw new StartCheckError(
      "SERVER_INFO_FAILED",
      `Server-Informationen nicht lesbar (${target}): ${describeError(error)}`,
    );
  }

  const setName = typeof hello.setName === "string" ? hello.setName : null;
  const sharded = hello.msg === "isdbgrid";
  if (setName === null && !sharded) {
    throw new StartCheckError(
      "NO_REPLICA_SET",
      `Change Streams brauchen ein Replica Set – ${target} ist ein Standalone-Server`,
    );
  }

  const major = serverMajorVersion(version);
  const versionRecommended = major >= RECOMMENDED_SERVER_MAJOR;
  if (!versionRecommended) {
    logger.warn(`MongoDB ${version} < ${RECOMMENDED_SERVER_MAJOR}.0 – empfohlen ist ≥ ${RECOMMENDED_SERVER_MAJOR}.0`);
  }
  const knownVulnerabilities = knownServerVulnerabilities(version);
  if (knownVulnerabilities === null) {
    logger.warn(`MongoDB-Version „${version}“ nicht auswertbar – Patchstand (u. a. CVE-2025-14847) nicht prüfbar`);
  } else if (knownVulnerabilities.length > 0) {
    logger.error(
      `SICHERHEIT: MongoDB ${version} (${target}) ist anfällig für ${knownVulnerabilities.join(", ")} – ` +
        `Server auf ${patchTarget(version)} aktualisieren (docs/03, docs/06)`,
    );
  }
  const topology = sharded ? "sharded" : "replicaSet";
  logger.info(`MongoDB ok: ${target}, Version ${version}, ${sharded ? "Sharded Cluster" : `Replica Set „${setName}“`}`);
  return { serverVersion: version, topology, setName, versionRecommended, knownVulnerabilities, transport };
}
