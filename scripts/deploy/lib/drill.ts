/**
 * Quell-Env für Drills des Deploy-Werkzeugs (`--test-env`, README „Vor dem Go-live offen“ → Drill): Test-Ports,
 * frische Zufalls-Secrets und die Test-Datenbank der automatischen Tests (ADR-029) mit eigenem Collection-Präfix.
 * Geprüft wird wie im Testmodus des Deploys (lib/source-env.ts): Schema, Dev-Regeln, nur `*_test`.
 */
import { randomBytes } from "node:crypto";
import { checkSourceRules, sourceEnvSchema } from "@quizmaster/shared/env";

/** Domain der Drill-Origin (wird nie aufgelöst; Smoke-Tests sprechen nur Loopback an). */
export const DRILL_DOMAIN = "drill.quizmaster.test";
export const DRILL_WEB_PORT = 7490;
export const DRILL_REALTIME_PORT = 7491;

/** Collection-Präfix der Test-Harness (`t<yyMMddHHmm>_<6>_`, @quizmaster/db/testing). */
const TEST_PREFIX = /^t\d{10}_[a-z0-9]{6}_$/;

export interface DrillInput {
  /** Verbindung zur Test-Datenbank – enthält ggf. Zugangsdaten, nie ausgeben. */
  uri: string;
  dbName: string;
  prefix: string;
  webPort: number;
  realtimePort: number;
  random?: (size: number) => Buffer;
}

/** Inhalt der Drill-Env; wirft (nur mit Schlüsselnamen, nie Werten), wenn eine Regel verletzt ist. */
export function drillEnv(input: DrillInput): Record<string, string> {
  const random = input.random ?? randomBytes;
  const secret = () => random(32).toString("base64url");
  const env: Record<string, string> = {
    QUIZMASTER_DOMAIN: DRILL_DOMAIN,
    QUIZMASTER_PORT: String(input.webPort),
    REALTIME_PORT: String(input.realtimePort),
    SEARCH_INDEXING: "false",
    MONGODB_URI: input.uri,
    MONGODB_DB: input.dbName,
    MONGODB_COLLECTION_PREFIX: input.prefix,
    SESSION_SECRET: secret(),
    REALTIME_TICKET_SECRET: secret(),
    IP_HASH_SECRET: secret(),
    METRICS_TOKEN: secret(),
    TURNSTILE_ENABLED: "false",
    GAME_TIMING: "normal",
    QUESTION_POOL: "all",
    DEV_BOTS_ENABLED: "false",
    LOG_LEVEL: "info",
  };
  const parsed = sourceEnvSchema.safeParse(env);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(Datei)"))];
    throw new Error(`Drill-Env ungültig: ${keys.join(", ")}`);
  }
  const problems = checkSourceRules(parsed.data, "dev");
  if (!input.dbName.endsWith("_test")) problems.push("TEST_DB: Drills nutzen nur *_test-Datenbanken");
  if (!TEST_PREFIX.test(input.prefix)) problems.push("TEST_PREFIX: Collection-Präfix der Test-Harness erwartet");
  if (input.webPort === input.realtimePort) problems.push("PORT_CONFLICT: Web- und Realtime-Port gleich");
  if (problems.length > 0) throw new Error(`Drill-Env verletzt Regeln: ${problems.join("; ")}`);
  return env;
}
