/**
 * `@quizmaster/db` – Datenschicht (docs/02 §Verantwortlichkeiten, docs/04): MongoClient-Fabrik,
 * Start-Checks, typisierte Collections, `ensureIndexes()`, Repositories, Change-Stream-Helfer und
 * Seed-Logik. Server-only. Test-Harness: `@quizmaster/db/testing`.
 */
import { PROTOCOL_VERSION } from "@quizmaster/shared";

/** Protokollversion, gegen die die Datenschicht gebaut ist. */
export const DB_PROTOCOL_VERSION: number = PROTOCOL_VERSION;

export * from "./client.ts";
export * from "./collections.ts";
export * from "./errors.ts";
export * from "./indexes.ts";
export * from "./logger.ts";
export * from "./repos/index.ts";
export * from "./seed/index.ts";
export * from "./start-checks.ts";
export * from "./validators.ts";
export * from "./watch.ts";
