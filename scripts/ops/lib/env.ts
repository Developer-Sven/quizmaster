/**
 * Env-Zugriff der Betriebsskripte: liest .env.prod/.env.dev über @quizmaster/shared/env (gleicher Parser und
 * gleiches Schema wie Apps und env:check). Fehlermeldungen nennen nur Schlüssel und Regeln – nie Werte.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { isTooPermissive, readEnvFile, type SourceEnv, sourceEnvSchema } from "@quizmaster/shared/env";

export class OpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsError";
  }
}

export function loadEnv(path: string): SourceEnv {
  const label = basename(path);
  if (!existsSync(path)) throw new OpsError(`${label} fehlt`);
  if (isTooPermissive(path)) throw new OpsError(`${label} ist für andere lesbar (chmod 600 ${label})`);
  const parsed = sourceEnvSchema.safeParse(readEnvFile(path));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(Datei)"}: ${issue.message}`);
    throw new OpsError(`${label} ungültig – ${issues.join("; ")}`);
  }
  return parsed.data;
}

/** Secrets nie ins Terminal: nur in Pipes/Variablen der aufrufenden Skripte. */
export function assertNotTerminal(what: string): void {
  if (process.stdout.isTTY) {
    throw new OpsError(`${what} wird nicht auf ein Terminal ausgegeben (nur für Skripte, z. B. $(…) oder <(…))`);
  }
}
