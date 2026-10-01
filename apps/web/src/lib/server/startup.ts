/**
 * Start-Checks von apps/web (docs/02 §Start-Checks, fail fast): 1. Env vollständig und gültig (zod),
 * 2.–4. MongoDB: Transport (TLS Pflicht außer *_dev/*_test), Ping (5 s), Replica Set, Version ≥ 8.0
 * (Warnung). `ensureIndexes()` macht Web bewusst nicht (nur Realtime/Seed). Bei Fehlern: klare Meldung
 * ohne Passwort, Prozess beendet sich (Exit 1). Aufruf nur zur Laufzeit aus `instrumentation.ts`.
 */
import { runStartChecks, type StartCheckResult } from "@quizmaster/db";
import type { Logger } from "pino";
import { getWebEnv, type WebEnv, WebEnvError } from "../../env";
import { allowInsecureDatabaseTransport, connectWebData } from "./db";
import { getLogger, toDbLogger } from "./logger";
import { TURNSTILE_TEST_SECRET_KEYS } from "./turnstile";

export interface StartupOptions {
  logger?: Logger;
  /** Standard `process.exit` – Tests ersetzen ihn. */
  exit?: (code: number) => never;
  /** Env-Quelle (Tests); Standard `getWebEnv()`. */
  env?: () => WebEnv;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Führt die Start-Checks aus; beendet bei einem Fehler den Prozess (`exit(1)`). */
export async function runWebStartupChecks(options: StartupOptions = {}): Promise<StartCheckResult> {
  const logger = options.logger ?? getLogger();
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let env: WebEnv;
  try {
    env = (options.env ?? getWebEnv)();
  } catch (error) {
    if (error instanceof WebEnvError || (error instanceof Error && error.name === "WebEnvError")) {
      const problems = (error as WebEnvError).problems ?? [];
      logger.fatal({ problems }, "Start abgebrochen: Web-Env unvollständig oder ungültig");
    } else {
      logger.fatal({ error: errorText(error) }, "Start abgebrochen: Web-Env nicht lesbar");
    }
    return exit(1);
  }

  const secretKey = env.turnstile.secretKey;
  if (secretKey !== undefined && TURNSTILE_TEST_SECRET_KEYS.includes(secretKey)) {
    if (!allowInsecureDatabaseTransport(env.mongodbDb)) {
      // Test-Schlüssel akzeptieren jedes Platzhalter-Token – außerhalb von Dev/Test ist der Bot-Schutz damit wirkungslos.
      logger.warn("WARNUNG: TURNSTILE_SECRET_KEY ist ein Cloudflare-Testschlüssel – Bot-Schutz wirkungslos");
    }
  }

  const dbLogger = toDbLogger(logger);
  try {
    const { client } = connectWebData(env, { logger: dbLogger });
    const result = await runStartChecks(client, {
      logger: dbLogger,
      allowInsecureTransport: allowInsecureDatabaseTransport(env.mongodbDb),
    });
    logger.info(
      { db: env.mongodbDb, topology: result.topology, serverVersion: result.serverVersion },
      "Start-Checks bestanden",
    );
    return result;
  } catch (error) {
    // StartCheckError-Meldungen enthalten nur maskierte Hosts – nie Zugangsdaten.
    const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
    logger.fatal(
      { code: typeof code === "string" ? code : undefined, error: errorText(error) },
      "Start abgebrochen: MongoDB-Start-Check fehlgeschlagen",
    );
    return exit(1);
  }
}
