// node scripts/env/run.ts <dev|prod> -- <befehl …>
// Lädt .env.<target>, leitet die Laufzeitwerte ab (Ports, Origins) und startet den Befehl mit
// der vereinigten Env von Web und Realtime. Gibt keine Werte aus.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkSourceRules,
  ENV_TARGETS,
  type EnvTarget,
  envFilePath,
  readEnvFile,
  realtimeProcessEnv,
  resolveEnv,
  sourceEnvSchema,
  webProcessEnv,
} from "@quizmaster/shared/env";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const separator = process.argv.indexOf("--");
const target = process.argv[2] as EnvTarget | undefined;
const command = separator === -1 ? [] : process.argv.slice(separator + 1);

if (!target || !ENV_TARGETS.includes(target) || command.length === 0) {
  console.error("Aufruf: node scripts/env/run.ts <dev|prod> -- <befehl …>");
  process.exit(2);
}
const path = envFilePath(ROOT, target);
if (!existsSync(path)) {
  console.error(`run – .env.${target} fehlt. Anlegen mit: pnpm setup:env ${target}`);
  process.exit(1);
}
const parsed = sourceEnvSchema.safeParse(readEnvFile(path));
if (!parsed.success) {
  console.error(`run – .env.${target} ist ungültig, Details: pnpm env:check ${target}`);
  process.exit(1);
}
const problems = checkSourceRules(parsed.data, target);
if (problems.length > 0) {
  for (const problem of problems) console.error(`run – ${problem}`);
  process.exit(1);
}

const resolved = resolveEnv(parsed.data, target);
const env = { ...process.env, ...realtimeProcessEnv(resolved), ...webProcessEnv(resolved) };
const [bin, ...args] = command as [string, ...string[]];
const child = spawn(bin, args, { cwd: ROOT, env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
