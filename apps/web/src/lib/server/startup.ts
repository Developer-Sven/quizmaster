/**
 * Start-Checks von apps/web (docs/02 §Start-Checks, fail fast): 1. Env vollständig und gültig (zod),
 * 2.–4. MongoDB: Transport (TLS Pflicht außer *_dev/*_test), Ping (5 s), Replica Set, Version ≥ 8.0
 * (Warnung). `ensureIndexes()` macht Web bewusst nicht (nur Realtime/Seed). Bei Fehlern: klare Meldung
 * ohne Passwort, Prozess beendet sich (Exit 1). Aufruf nur zur Laufzeit aus `instrumentation.ts`.
 */
import { runStartChecks, type StartCheckResult } from "@quizmaster/db";
import type { Logger } from "pino";
import { getWebEnv, isDevOrTestDatabase, TURNSTILE_TEST_SECRET_KEYS, type WebEnv, WebEnvError } from "../../env";
import { allowInsecureDatabaseTransport, connectWebData } from "./db";
import { getLogger, toDbLogger } from "./logger";

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

/**
 * Bot-Schutz beim Start sichtbar machen (docs/06 §Bot-Schutz, Phase-4-Punkt „Turnstile in Prod aktiv“) – nur bei
 * einer Produktions-Datenbank (Dev/Test laufen bewusst ohne). Nur Warnungen, kein Abbruch: Einschalten und
 * Schlüssel gehören dem Betrieb (Cloudflare-Dashboard → Env-Datei). Ohne Site Key und Secret im Web-Prozess gäbe es
 * weder Widget noch Siteverify – der Notfall-Schalter `appConfig.turnstileOnJoin` sperrte dann jeden Beitritt aus.
 * Geloggt werden nur Schlüsselnamen, nie Werte.
 */
function warnAboutDisabledTurnstile(env: WebEnv, logger: Logger): void {
  if (isDevOrTestDatabase(env.mongodbDb)) return;
  if (!env.turnstile.enabled) {
    logger.warn(
      { db: env.mongodbDb },
      "Turnstile aus: TURNSTILE_ENABLED ist nicht true – neue Sessions entstehen ohne Bot-Prüfung",
    );
  }
  const missing = [
    ...(env.turnstile.siteKey === undefined ? ["TURNSTILE_SITE_KEY"] : []),
    ...(env.turnstile.secretKey === undefined ? ["TURNSTILE_SECRET_KEY"] : []),
  ];
  if (missing.length > 0) {
    logger.warn(
      { missing },
      "Turnstile nicht konfiguriert: Der Notfall-Schalter appConfig.turnstileOnJoin würde jeden Beitritt sperren – " +
        "erst Schlüssel eintragen",
    );
  }
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

  // Fail-closed (docs/06 §Bot-Schutz): Test-Schlüssel akzeptieren jedes Platzhalter-Token bzw. lehnen alles ab –
  // außerhalb von Dev/Test wäre der Bot-Schutz wirkungslos. Die Env-Regel (env.ts) greift schon beim Parsen;
  // diese Prüfung sichert auch eine anders entstandene Env ab.
  const secretKey = env.turnstile.secretKey;
  if (
    secretKey !== undefined &&
    TURNSTILE_TEST_SECRET_KEYS.includes(secretKey) &&
    !isDevOrTestDatabase(env.mongodbDb)
  ) {
    logger.fatal(
      { db: env.mongodbDb },
      "Start abgebrochen: TURNSTILE_SECRET_KEY ist ein Cloudflare-Testschlüssel – nur mit *_dev/*_test-Datenbank erlaubt",
    );
    return exit(1);
  }

  warnAboutDisabledTurnstile(env, logger);

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
