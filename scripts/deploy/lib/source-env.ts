/**
 * Quelle der Laufzeit-Env: `.env.prod` (ADR-022). Nur für Tests des Deploy-Werkzeugs gibt es `--test-env`:
 * eine eigene Datei mit Test-Ports und einer `*_test`-Datenbank (ADR-029), die nach den Dev-Regeln geprüft
 * wird; die Apps laufen trotzdem als Produktions-Build (`resolveEnv(…, "prod")`). Ausgaben nennen nur
 * Schlüssel und Regeln, nie Werte.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  checkSourceRules,
  envFilePath,
  isTooPermissive,
  type ResolvedEnv,
  readEnvFile,
  resolveEnv,
  type SourceEnv,
  sourceEnvSchema,
} from "@quizmaster/shared/env";
import { DeployError } from "./log.ts";

export type SourceMode = "prod" | "test";

export interface SourceContext {
  mode: SourceMode;
  path: string;
  /** Anzeigename für Kopfzeilen und Meldungen (nie Werte). */
  label: string;
  resolved: ResolvedEnv;
}

function parseSource(path: string, label: string): SourceEnv {
  if (!existsSync(path)) throw new DeployError("ENV_MISSING", `${label} fehlt`);
  if (isTooPermissive(path)) throw new DeployError("ENV_MODE", `${label} ist für andere lesbar (chmod 600 ${label})`);
  const parsed = sourceEnvSchema.safeParse(readEnvFile(path));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(Datei)"}: ${issue.message}`);
    throw new DeployError("ENV_INVALID", `${label} ungültig – ${issues.join("; ")}`);
  }
  return parsed.data;
}

export function loadSource(root: string, testEnvPath: string | null): SourceContext {
  if (testEnvPath === null) {
    const path = envFilePath(root, "prod");
    const source = parseSource(path, ".env.prod");
    const problems = checkSourceRules(source, "prod");
    if (problems.length > 0) throw new DeployError("ENV_RULES", `.env.prod: ${problems.join("; ")}`);
    return { mode: "prod", path, label: ".env.prod", resolved: resolveEnv(source, "prod") };
  }

  const label = basename(testEnvPath);
  const source = parseSource(testEnvPath, label);
  const problems = checkSourceRules(source, "dev");
  if (!source.MONGODB_DB.endsWith("_test")) problems.push("TEST_DB: Test-Deploys nutzen nur *_test-Datenbanken");
  if (!source.QUIZMASTER_DOMAIN) problems.push("DOMAIN_MISSING: QUIZMASTER_DOMAIN fehlt (für die Origin)");
  const resolved = resolveEnv(source, "prod");
  // Nie die Ports der Produktion belegen.
  const prodPath = envFilePath(root, "prod");
  if (existsSync(prodPath)) {
    const prod = sourceEnvSchema.safeParse(readEnvFile(prodPath));
    if (prod.success) {
      const prodResolved = resolveEnv(prod.data, "prod");
      const prodPorts = new Set([prodResolved.webPort, prodResolved.realtimePort]);
      if (prodPorts.has(resolved.webPort) || prodPorts.has(resolved.realtimePort)) {
        problems.push("TEST_PORTS: Test-Deploy darf nicht die Ports aus .env.prod verwenden");
      }
    }
  }
  if (problems.length > 0) throw new DeployError("ENV_RULES", `${label}: ${problems.join("; ")}`);
  return { mode: "test", path: testEnvPath, label, resolved };
}
