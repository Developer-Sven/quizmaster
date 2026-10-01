/**
 * Prozess-Einstieg des Realtime-Servers (docs/02 §Start-Checks, docs/12, ADR-024):
 * Env (zod) → MongoClient (appName quizmaster-realtime, Pool 20) → Start-Checks → ensureIndexes → App →
 * Wiederaufnahme laufender Lobbys aus Snapshots (`resume/`) → `listen(HOST, REALTIME_PORT)` →
 * `process.send("ready")` (pm2 `wait_ready`).
 *
 * Graceful Shutdown bei SIGTERM und SIGINT (`installProcessShutdown`: `app.stop()`, dann MongoClient
 * schließen, Exit < 10 s); ein zweites Signal beendet sofort. Unerwartete Fehler → Log `fatal`, Exit 1.
 */
import { closeMongoClient } from "@quizmaster/db";
import pino from "pino";
import { connectRealtimeDb, createRealtimeApp, installProcessShutdown, type RealtimeApp } from "./app.ts";
import { parseRealtimeEnv } from "./env.ts";
import { createLogger } from "./logger.ts";
import { REALTIME_MODULES } from "./registry/modules.ts";
import type { RealtimeDb } from "./registry/types.ts";
import { resumeModule } from "./resume/index.ts";

const destination = pino.destination({ dest: 1, sync: false });

function exit(code: number): never {
  destination.flushSync();
  process.exit(code);
}

async function main(): Promise<void> {
  const parsed = parseRealtimeEnv(process.env);
  if (!parsed.ok) {
    console.error(`realtime – Env ungültig:\n${parsed.problems.map((problem) => `  - ${problem}`).join("\n")}`);
    exit(1);
  }
  const env = parsed.env;
  const logger = createLogger({ level: env.LOG_LEVEL, destination });
  logger.info({ database: env.MONGODB_DB, timing: env.GAME_TIMING, rateLimits: env.RATE_LIMIT_MODE }, "Start");

  let db: RealtimeDb | undefined;
  let app: RealtimeApp | undefined;
  try {
    db = await connectRealtimeDb(env, logger);
    // Wiederaufnahme laufender Lobbys aus Snapshots nach dem Lobby-Modul, vor `listen` (docs/07 Phase 6).
    app = await createRealtimeApp({ env, db, logger, modules: [...REALTIME_MODULES, resumeModule] });
    const client = db.client;
    installProcessShutdown({ app, logger, exit, afterStop: () => closeMongoClient(client) });
    await app.start();
  } catch (error) {
    logger.fatal({ err: error }, "Start fehlgeschlagen");
    try {
      await app?.stop("start_failed");
      if (db !== undefined) await closeMongoClient(db.client);
    } catch (cleanupError) {
      logger.error({ err: cleanupError }, "Aufräumen nach fehlgeschlagenem Start fehlgeschlagen");
    }
    exit(1);
  }
  process.send?.("ready");
}

main().catch((error: unknown) => {
  console.error("realtime – unerwarteter Fehler beim Start", error instanceof Error ? error.message : error);
  exit(1);
});
