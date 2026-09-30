/**
 * Start-Checks (docs/02 §Start-Checks, fail fast): Ping (5 s), Replica Set bzw. Sharded Cluster
 * (Change Streams + Transaktionen), Server-Version (≥ 8.0 empfohlen → sonst Warnung).
 * `ensureIndexes()` ist ein eigener Schritt (nur Realtime und Seed).
 */
import type { MongoClient } from "mongodb";
import { describeClientHosts } from "./client.ts";
import { type DbLogger, describeError, silentLogger } from "./logger.ts";

export const START_CHECK_PING_TIMEOUT_MS = 5_000;
export const RECOMMENDED_SERVER_MAJOR = 8;

export const START_CHECK_ERROR_CODES = ["PING_FAILED", "NO_REPLICA_SET", "SERVER_INFO_FAILED"] as const;
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
}

export interface StartCheckOptions {
  logger?: DbLogger;
  /** Ping-Frist (Standard 5 s). */
  pingTimeoutMs?: number;
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
  const topology = sharded ? "sharded" : "replicaSet";
  logger.info(`MongoDB ok: ${target}, Version ${version}, ${sharded ? "Sharded Cluster" : `Replica Set „${setName}“`}`);
  return { serverVersion: version, topology, setName, versionRecommended };
}
