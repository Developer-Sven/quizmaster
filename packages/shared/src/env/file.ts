import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { EnvTarget } from "./schema.ts";

/** Pfad der Env-Datei einer Umgebung im Repo-Root (ADR-022). */
export function envFilePath(repoRoot: string, target: EnvTarget): string {
  return join(repoRoot, `.env.${target}`);
}

/** Liest eine Env-Datei (dotenv-Format, keine Variablen-Expansion) ohne sie irgendwo auszugeben. */
export function readEnvFile(path: string): Record<string, string> {
  const parsed = parseEnv(readFileSync(path, "utf8"));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/** true, wenn Gruppe oder andere die Datei lesen dürfen (Soll: 600). */
export function isTooPermissive(path: string): boolean {
  return (statSync(path).mode & 0o077) !== 0;
}

/** Maskiert eine MongoDB-URI für Logs: Zugangsdaten und Query entfernen, nur Hosts zeigen. */
export function maskMongoUri(uri: string): string {
  const match = /^(mongodb(?:\+srv)?:\/\/)(?:[^@/]*@)?([^/?]*)/.exec(uri);
  if (!match) return "mongodb://***";
  const hosts = (match[2] ?? "")
    .split(",")
    .map((host) => host.replace(/^([^.:]{2})[^.:]*/, "$1***"))
    .join(",");
  return `${match[1]}***@${hosts}`;
}
