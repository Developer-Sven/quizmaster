// pnpm env:check <dev|prod> [--connect]
// Prüft .env.<target> gegen das Schema und die Regeln der Zielumgebung. Gibt nur Schlüsselnamen,
// Fehlercodes und maskierte Hosts aus – niemals Werte (ADR-022).
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  checkSourceRules,
  ENV_TARGETS,
  type EnvTarget,
  envFilePath,
  isTooPermissive,
  maskMongoUri,
  readEnvFile,
  resolveEnv,
  sourceEnvSchema,
  sourceWarnings,
} from "@quizmaster/shared/env";
import { MongoClient } from "mongodb";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { connect: { type: "boolean", default: false } },
});
const target = positionals[0] as EnvTarget | undefined;
if (!target || !ENV_TARGETS.includes(target)) {
  console.error("Aufruf: pnpm env:check <dev|prod> [--connect]");
  process.exit(2);
}

const path = envFilePath(ROOT, target);
if (!existsSync(path)) {
  console.error(`env:check – .env.${target} fehlt. Anlegen mit: pnpm setup:env ${target}`);
  process.exit(1);
}

let failed = false;
if (isTooPermissive(path)) {
  console.warn(`env:check – WARNUNG FILE_MODE: .env.${target} ist für andere lesbar (chmod 600 .env.${target})`);
}

const parsed = sourceEnvSchema.safeParse(readEnvFile(path));
if (!parsed.success) {
  for (const issue of parsed.error.issues) {
    console.error(`env:check – FEHLER ${issue.path.join(".") || "(Datei)"}: ${issue.message}`);
  }
  process.exit(1);
}
const source = parsed.data;
for (const problem of checkSourceRules(source, target)) {
  console.error(`env:check – FEHLER ${problem}`);
  failed = true;
}
for (const warning of sourceWarnings(source, target)) console.warn(`env:check – WARNUNG ${warning}`);
if (target === "prod") {
  for (const key of ["TLS_CERT_FILE", "TLS_KEY_FILE"] as const) {
    const file = source[key];
    if (file && !existsSync(file)) {
      console.error(`env:check – FEHLER TLS_FILE_MISSING: ${key} zeigt auf eine nicht vorhandene Datei`);
      failed = true;
    }
  }
}

const resolved = resolveEnv(source, target);
console.log(
  `env:check – .env.${target}: Origin ${resolved.appOrigin}, Web :${resolved.webPort}, Realtime :${resolved.realtimePort}, DB ${source.MONGODB_DB}`,
);

async function checkConnection(): Promise<boolean> {
  const client = new MongoClient(source.MONGODB_URI, {
    appName: `quizmaster-envcheck-${target}`,
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
  });
  const host = maskMongoUri(source.MONGODB_URI);
  try {
    await client.connect();
    const admin = client.db("admin");
    await admin.command({ ping: 1 });
    const hello = await admin.command({ hello: 1 });
    const isReplicaSet = typeof hello.setName === "string" || hello.msg === "isdbgrid";
    const build = await admin.command({ buildInfo: 1 });
    const version = String(build.version ?? "?");
    const major = Number.parseInt(version, 10);
    console.log(`env:check – Verbindung ok (${host}), Server ${version}, Replica Set: ${isReplicaSet ? "ja" : "NEIN"}`);
    let ok = true;
    if (!isReplicaSet) {
      console.error("env:check – FEHLER NO_REPLICA_SET: Change Streams und Transaktionen brauchen ein Replica Set");
      ok = false;
    }
    if (!(major >= 8)) console.warn(`env:check – WARNUNG SERVER_VERSION: ${version} < 8.0`);
    const status = await admin.command({ connectionStatus: 1, showPrivileges: true });
    const privileges: Array<{
      resource?: { db?: string; collection?: string; anyResource?: boolean };
      actions?: string[];
    }> = status.authInfo?.authenticatedUserPrivileges ?? [];
    const needed = ["find", "insert", "update", "remove", "createCollection", "createIndex", "changeStream"];
    const databases = [
      source.MONGODB_DB,
      ...(target === "dev" && source.TEST_MONGODB_DB ? [source.TEST_MONGODB_DB] : []),
    ];
    for (const db of databases) {
      const granted = new Set<string>();
      for (const privilege of privileges) {
        const resource = privilege.resource ?? {};
        const matches =
          resource.anyResource === true ||
          ((resource.db === db || resource.db === "") && (resource.collection ?? "") === "");
        if (matches) for (const action of privilege.actions ?? []) granted.add(action);
      }
      const missing = needed.filter((action) => !granted.has(action));
      if (privileges.length === 0) {
        console.warn(`env:check – WARNUNG PRIVILEGES_UNKNOWN: Rechte für ${db} nicht auslesbar`);
      } else if (missing.length > 0) {
        console.error(
          `env:check – FEHLER PRIVILEGES: auf ${db} fehlen ${missing.join(", ")} (Rolle readWrite@${db} nötig)`,
        );
        ok = false;
      } else {
        const extra = granted.has("collMod") ? " inkl. collMod" : "";
        console.log(`env:check – Rechte auf ${db}: readWrite ok${extra}`);
      }
    }
    return ok;
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message.replaceAll(source.MONGODB_URI, host) : "unbekannt";
    console.error(`env:check – FEHLER CONNECT (${host}): ${name}: ${message}`);
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

if (values.connect && !(await checkConnection())) failed = true;
if (failed) process.exit(1);
console.log(`env:check – .env.${target} ok`);
