// Admin-CLI für den Notfall (docs/06 §Notfall-Runbook, docs/13 Phase 4, README „Runbooks“): Kill-Switches in
// appConfig und Sperren (bans). Realtime übernimmt Änderungen live per Change Stream – kein Neustart nötig.
//
//   pnpm admin:config show
//   pnpm admin:config set lobbyCreationEnabled=false turnstileOnJoin=true maxActiveLobbies=500 --confirm-prod
//   pnpm admin:config set maintenance=on "maintenanceMessage=Kurze Wartung, gleich zurück" --confirm-prod
//   pnpm admin:config block-term add|remove <begriff …> --confirm-prod
//   pnpm admin:ban add (--guest <guestId> | --ip <adresse>) --reason "<grund>" [--hours <n>] --confirm-prod
//   pnpm admin:ban remove (--guest <guestId> | --ip <adresse>) --confirm-prod
//   pnpm admin:ban check (--guest <guestId> | --ip <adresse>)
//
// Verbindung aus .env.<env> (--env prod|dev, Standard prod) bzw. --env-file <datei> – Zugangsdaten werden nie
// ausgegeben. Schreiben in eine Produktionsdatenbank (nicht *_dev/*_test) nur mit --confirm-prod. IP-Sperren
// speichern wie Web/Realtime nur den HMAC-Schlüssel (IP_HASH_SECRET, IPv6 als /64), nie die IP.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  closeMongoClient,
  createAppConfigRepo,
  createBansRepo,
  createMongoClient,
  describeClientHosts,
  getCollections,
  MONGO_POOL_SIZES,
} from "@quizmaster/db";
import { envFilePath } from "@quizmaster/shared/env";
import {
  AdminUsageError,
  assertWriteAllowed,
  banExpiry,
  banTarget,
  describeBan,
  describeConfig,
  parseConfigAssignments,
  updateBlockedTerms,
} from "./lib/admin.ts";
import { loadEnv, OpsError } from "./lib/env.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const USAGE = `Aufruf:
  pnpm admin:config show
  pnpm admin:config set <schlüssel=wert …> --confirm-prod
      lobbyCreationEnabled=true|false  turnstileOnJoin=true|false  maxActiveLobbies=<n>  minClientProtocol=<n>
      maintenance=on|off  maintenanceMessage=<text>
  pnpm admin:config block-term add|remove <begriff …> --confirm-prod
  pnpm admin:ban add (--guest <guestId> | --ip <adresse>) --reason "<grund>" [--hours <n>] --confirm-prod
  pnpm admin:ban remove (--guest <guestId> | --ip <adresse>) --confirm-prod
  pnpm admin:ban check (--guest <guestId> | --ip <adresse>)
Optionen: --env prod|dev (Standard prod) · --env-file <datei>`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: "string", default: "prod" },
    "env-file": { type: "string" },
    "confirm-prod": { type: "boolean", default: false },
    guest: { type: "string" },
    ip: { type: "string" },
    reason: { type: "string" },
    hours: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const log = (line: string) => console.info(`admin – ${line}`);

async function main(): Promise<void> {
  const [area, action, ...rest] = positionals;
  if (values.help || (area !== "config" && area !== "ban")) throw new AdminUsageError(USAGE);
  if (values.env !== "prod" && values.env !== "dev") throw new AdminUsageError("--env erwartet prod oder dev");
  // Erst Argumente prüfen, dann die Env-Datei lesen und verbinden.
  const writes = action !== "show" && action !== "check";
  if (area === "config" && !["show", "set", "block-term"].includes(action ?? "")) throw new AdminUsageError(USAGE);
  if (area === "ban" && !["add", "remove", "check"].includes(action ?? "")) throw new AdminUsageError(USAGE);
  const patch = area === "config" && action === "set" ? parseConfigAssignments(rest) : null;
  if (area === "ban" && action === "add" && !values.reason?.trim()) throw new AdminUsageError("--reason fehlt");
  const expiresAt = banExpiry(values.hours, new Date());

  const env = loadEnv(values["env-file"] ? resolve(values["env-file"]) : envFilePath(ROOT, values.env));
  if (writes) assertWriteAllowed(env.MONGODB_DB, values["confirm-prod"]);
  const target = area === "ban" ? banTarget({ guest: values.guest, ip: values.ip }, env.IP_HASH_SECRET) : null;
  const prefix = env.MONGODB_DB.endsWith("_test") ? env.MONGODB_COLLECTION_PREFIX : undefined;

  const client = createMongoClient(env.MONGODB_URI, {
    appName: "quizmaster-admin",
    maxPoolSize: MONGO_POOL_SIZES.script,
    cache: false,
  });
  try {
    log(`Ziel ${describeClientHosts(client)} / ${env.MONGODB_DB}${prefix ? ` (Präfix ${prefix})` : ""}`);
    const collections = getCollections(client.db(env.MONGODB_DB), { prefix });
    const now = new Date();
    if (area === "config") {
      const repo = createAppConfigRepo(collections.appConfig);
      if (patch !== null) {
        const updated = await repo.update(patch, now);
        log("appConfig geändert (Realtime übernimmt es per Change Stream):");
        for (const line of describeConfig(updated)) console.info(`  ${line}`);
      } else if (action === "block-term") {
        const current = await repo.get();
        const [mode, ...terms] = rest;
        const next = updateBlockedTerms(current.blockedTerms, mode ?? "", terms);
        const updated = await repo.update({ blockedTerms: next }, now);
        log(
          `Blockliste: ${current.blockedTerms.length} → ${updated.blockedTerms.length} Begriffe (wirkt beim nächsten Beitritt)`,
        );
      } else {
        for (const line of describeConfig(await repo.get())) console.info(`  ${line}`);
      }
      return;
    }
    if (target === null) throw new AdminUsageError(USAGE);
    const bans = createBansRepo(collections.bans);
    if (action === "add") {
      const ban = await bans.upsert(
        { kind: target.kind, value: target.value, reason: values.reason ?? "", expiresAt },
        now,
      );
      log(`${target.label} gesperrt: ${describeBan(ban)} – bestehende Verbindungen trennt Realtime per Change Stream`);
    } else if (action === "remove") {
      log(
        `${target.label}: ${(await bans.remove(target.kind, target.value)) ? "Sperre aufgehoben" : "keine Sperre vorhanden"}`,
      );
    } else {
      const ban = await bans.findActive(target.kind, target.value, now);
      log(`${target.label}: ${ban ? describeBan(ban) : "nicht gesperrt"}`);
    }
  } finally {
    await closeMongoClient(client).catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof AdminUsageError || error instanceof OpsError
      ? error.message
      : error instanceof Error
        ? `${error.name}: ${error.message.replace(/mongodb(\+srv)?:\/\/\S*/g, "mongodb://***")}`
        : String(error);
  console.error(`admin – ${message}`);
  process.exit(error instanceof AdminUsageError ? 2 : 1);
});
