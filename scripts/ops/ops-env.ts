// Liefert Betriebsskripten einzelne Werte aus einer Env-Datei – ohne dass sie je im Terminal, in der
// Prozessliste oder in Logs landen (Aufruf nur aus infra/ops/*.sh):
//
//   node scripts/ops/ops-env.ts mongo-config --env-file .env.prod     YAML für mongodump/mongorestore --config
//   node scripts/ops/ops-env.ts value --env-file .env.prod --key MONGODB_DB
//
// Secrets (URI, BACKUP_PASSPHRASE) werden nur ausgegeben, wenn stdout kein Terminal ist.
import { resolveTxt } from "node:dns/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { assertNotTerminal, loadEnv, OpsError } from "./lib/env.ts";
import { authSourceFromTxt, mongoToolsConfig, srvHost, withExplicitAuthSource } from "./lib/mongo-tools.ts";

const PLAIN_KEYS = ["MONGODB_DB", "TEST_MONGODB_DB", "QUIZMASTER_DOMAIN"] as const;
const SECRET_KEYS = ["BACKUP_PASSPHRASE"] as const;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "env-file": { type: "string" }, key: { type: "string" } },
  });
  const command = positionals[0];
  if (!values["env-file"] || (command !== "mongo-config" && command !== "value")) {
    throw new OpsError("Aufruf: ops-env.ts mongo-config|value --env-file <datei> [--key <SCHLÜSSEL>]");
  }
  const env = loadEnv(resolve(values["env-file"]));

  if (command === "mongo-config") {
    assertNotTerminal("Die Datenbank-URI");
    const host = srvHost(env.MONGODB_URI);
    let txtAuthSource: string | null = null;
    if (host !== null) {
      try {
        txtAuthSource = authSourceFromTxt(await resolveTxt(host));
      } catch {
        // kein TXT-Eintrag → Standard des Treibers (admin bzw. Pfad-Datenbank)
      }
    }
    process.stdout.write(mongoToolsConfig(withExplicitAuthSource(env.MONGODB_URI, txtAuthSource)));
    return;
  }

  const key = values.key ?? "";
  if ((SECRET_KEYS as readonly string[]).includes(key)) {
    assertNotTerminal(key);
    const value = env.BACKUP_PASSPHRASE;
    if (!value) throw new OpsError(`${key} fehlt in ${values["env-file"]}`);
    process.stdout.write(`${value}\n`);
    return;
  }
  if (!(PLAIN_KEYS as readonly string[]).includes(key)) {
    throw new OpsError(`--key erlaubt nur ${[...PLAIN_KEYS, ...SECRET_KEYS].join(", ")}`);
  }
  const value = env[key as (typeof PLAIN_KEYS)[number]];
  if (!value) throw new OpsError(`${key} fehlt`);
  if (key === "TEST_MONGODB_DB" && !value.endsWith("_test")) throw new OpsError("TEST_MONGODB_DB muss auf _test enden");
  process.stdout.write(`${value}\n`);
}

main().catch((error: unknown) => {
  console.error(`ops-env – ${error instanceof OpsError ? error.message : "unerwarteter Fehler"}`);
  process.exit(1);
});
