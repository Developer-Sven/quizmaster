// pnpm env:check <dev|prod> [--connect]
// Prüft .env.<target> gegen das Schema und die Regeln der Zielumgebung. Gibt nur Schlüsselnamen,
// Fehlercodes und maskierte Hosts aus – niemals Werte (ADR-022). --connect: Transport (TLS), Verbindung,
// Replica Set, Version, Patchstand (bekannte Server-Lücken wie CVE-2025-14847 – prod: Fehler) und Rechte
// (fehlende UND überzählige – Least Privilege, docs/04).
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { clientTransport, knownServerVulnerabilities, patchTarget } from "@quizmaster/db";
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
import { assessPrivileges, type Privilege } from "./privileges.ts";

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
  // Vor dem Verbinden: ohne geprüftes TLS gingen Zugangsdaten im Klartext übers Netz (docs/04, 06, 12).
  if (clientTransport(client) === "insecure") {
    if (target === "prod") {
      console.error(`env:check – FEHLER MONGODB_TLS: ${host} ohne (geprüftes) TLS – Verbindung nicht aufgebaut`);
      await client.close().catch(() => undefined);
      return false;
    }
    console.warn(`env:check – WARNUNG MONGODB_TLS_OFF: ${host} ohne (geprüftes) TLS – nur in Entwicklung geduldet`);
  }
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
    const vulnerabilities = knownServerVulnerabilities(version);
    if (vulnerabilities === null) {
      console.warn(
        `env:check – WARNUNG SERVER_PATCH_UNKNOWN: Version „${version}“ nicht auswertbar – Patchstand prüfen`,
      );
    } else if (vulnerabilities.length > 0) {
      const line = `SERVER_PATCH: ${version} ist anfällig für ${vulnerabilities.join(", ")} – auf ${patchTarget(version)} aktualisieren`;
      if (target === "prod") {
        console.error(`env:check – FEHLER ${line}`);
        ok = false;
      } else {
        console.warn(`env:check – WARNUNG ${line}`);
      }
    }
    const status = await admin.command({ connectionStatus: 1, showPrivileges: true });
    const privileges: Privilege[] = status.authInfo?.authenticatedUserPrivileges ?? [];
    const databases = [
      source.MONGODB_DB,
      ...(target === "dev" && source.TEST_MONGODB_DB ? [source.TEST_MONGODB_DB] : []),
    ];
    const report = assessPrivileges(privileges, databases);
    const tooBroad = report.excessive.length > 0;
    for (const db of databases) {
      const missing = report.missing.get(db) ?? [];
      if (privileges.length === 0) {
        console.warn(`env:check – WARNUNG PRIVILEGES_UNKNOWN: Rechte für ${db} nicht auslesbar`);
      } else if (missing.length > 0) {
        console.error(
          `env:check – FEHLER PRIVILEGES: auf ${db} fehlen ${missing.join(", ")} (Rolle readWrite@${db} nötig)`,
        );
        ok = false;
      } else {
        const extra = report.collMod.has(db) ? " inkl. collMod" : "";
        const verdict = tooBroad ? "readWrite vorhanden, aber zu weit (siehe PRIVILEGES_EXCESSIVE)" : "readWrite ok";
        console.log(`env:check – Rechte auf ${db}: ${verdict}${extra}`);
      }
    }
    if (tooBroad) {
      const line =
        `PRIVILEGES_EXCESSIVE: Benutzer hat mehr als readWrite – ${report.excessive.join(", ")} ` +
        "(Least Privilege: eigener Benutzer nur mit readWrite auf der eigenen Datenbank, docs/04)";
      if (target === "prod") {
        console.error(`env:check – FEHLER ${line}`);
        ok = false;
      } else {
        console.warn(`env:check – WARNUNG ${line}`);
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
