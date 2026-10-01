// Admin-CLI für den Notfall (docs/06 §Notfall-Runbook, docs/13 Phase 4, README „Runbooks“): Kill-Switches in
// appConfig, Sperren (bans) und das Bereinigen von Abnahme-/Testspielen. Realtime übernimmt appConfig und Sperren
// live per Change Stream (Sperre → betroffene Sockets sofort getrennt) – kein Neustart nötig.
//
//   pnpm admin:config show
//   pnpm admin:config set lobbyCreationEnabled=false turnstileOnJoin=true maxActiveLobbies=500 --confirm-prod
//   pnpm admin:config maintenance on "Kurze Wartung, gleich zurück" --confirm-prod   (bzw. maintenance off)
//   pnpm admin:config block-term add|remove <begriff …> --confirm-prod
//   pnpm admin:config block-term list
//   pnpm admin:ban add <ziel> --reason "<grund>" [--hours <n>] --confirm-prod
//   pnpm admin:ban remove <ziel> --confirm-prod
//   pnpm admin:ban check <ziel>
//   pnpm admin:ban list            (auch: pnpm admin:ban --list)
//     <ziel> = --guest <guestId> | --ip <adresse> | --lobby <code> --name <name> | --report <meldungs-id>
//   pnpm admin:game purge --code <CODE> [--dry-run] --confirm-prod
//
// Verbindung aus .env.<env> (--env prod|dev, Standard prod) bzw. --env-file <datei> – Zugangsdaten werden nie
// ausgegeben, guestIds nur gekürzt. Schreiben in eine Produktionsdatenbank (nicht *_dev/*_test) nur mit
// --confirm-prod. IP-Sperren speichern wie Web/Realtime nur den HMAC-Schlüssel (IP_HASH_SECRET, IPv6 als /64).
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
  banTargetKind,
  describeBan,
  describeBanLine,
  describeBlockedTerms,
  describeConfig,
  describePurge,
  maintenancePatch,
  parseConfigAssignments,
  purgeGamesByCode,
  resolveBanTarget,
  turnstileWarning,
  updateBlockedTerms,
} from "./lib/admin.ts";
import { loadEnv, OpsError } from "./lib/env.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const USAGE = `Aufruf:
  pnpm admin:config show
  pnpm admin:config set <schlüssel=wert …> --confirm-prod
      lobbyCreationEnabled=true|false  turnstileOnJoin=true|false  maxActiveLobbies=<n>  minClientProtocol=<n>
      maintenance=on|off  maintenanceMessage=<text>
  pnpm admin:config maintenance on "<text>" | off --confirm-prod
  pnpm admin:config block-term add|remove <begriff …> --confirm-prod
  pnpm admin:config block-term list
  pnpm admin:ban add <ziel> --reason "<grund>" [--hours <n>] --confirm-prod
  pnpm admin:ban remove <ziel> --confirm-prod
  pnpm admin:ban check <ziel>
  pnpm admin:ban list          (oder: pnpm admin:ban --list)
      <ziel> = --guest <guestId> | --ip <adresse> | --lobby <code> --name <name> | --report <meldungs-id>
  pnpm admin:game purge --code <CODE> [--dry-run] --confirm-prod
Optionen: --env prod|dev (Standard prod) · --env-file <datei>`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: "string", default: "prod" },
    "env-file": { type: "string" },
    "confirm-prod": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    guest: { type: "string" },
    ip: { type: "string" },
    lobby: { type: "string" },
    name: { type: "string" },
    report: { type: "string" },
    code: { type: "string" },
    reason: { type: "string" },
    hours: { type: "string" },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const log = (line: string) => console.info(`admin – ${line}`);

const ACTIONS: Readonly<Record<string, readonly string[]>> = {
  config: ["show", "set", "maintenance", "block-term"],
  ban: ["add", "remove", "check", "list"],
  game: ["purge"],
};

/** Lesende Aktionen (ohne --confirm-prod auch gegen Produktion erlaubt). */
function isReadOnly(area: string, action: string, rest: readonly string[]): boolean {
  if (area === "config") return action === "show" || (action === "block-term" && rest[0] === "list");
  if (area === "ban") return action === "check" || action === "list";
  return values["dry-run"];
}

async function main(): Promise<void> {
  const [area = "", rawAction, ...rest] = positionals;
  const action = area === "ban" && values.list && rawAction === undefined ? "list" : (rawAction ?? "");
  if (values.help || !(area in ACTIONS)) throw new AdminUsageError(USAGE);
  if (!ACTIONS[area]?.includes(action)) throw new AdminUsageError(USAGE);
  if (values.env !== "prod" && values.env !== "dev") throw new AdminUsageError("--env erwartet prod oder dev");

  // Erst alle Argumente prüfen, dann die Env-Datei lesen und verbinden.
  const patch =
    area === "config" && action === "set"
      ? parseConfigAssignments(rest)
      : area === "config" && action === "maintenance"
        ? maintenancePatch(rest[0], rest.slice(1))
        : null;
  if (area === "config" && action === "block-term" && !["add", "remove", "list"].includes(rest[0] ?? "")) {
    throw new AdminUsageError("block-term erwartet add, remove oder list");
  }
  const targetOptions = {
    guest: values.guest,
    ip: values.ip,
    lobby: values.lobby,
    name: values.name,
    report: values.report,
  };
  if (area === "ban" && action !== "list") banTargetKind(targetOptions);
  if (area === "ban" && action === "add" && !values.reason?.trim()) throw new AdminUsageError("--reason fehlt");
  if (area === "game" && values.code === undefined) throw new AdminUsageError("--code <CODE> fehlt");
  const expiresAt = banExpiry(values.hours, new Date());

  const env = loadEnv(values["env-file"] ? resolve(values["env-file"]) : envFilePath(ROOT, values.env));
  if (!isReadOnly(area, action, rest)) assertWriteAllowed(env.MONGODB_DB, values["confirm-prod"]);
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
        const warning = turnstileWarning(patch, env);
        if (warning !== null) console.warn(`admin – ${warning}`);
        const updated = await repo.update(patch, now);
        log("appConfig geändert (Realtime übernimmt es per Change Stream):");
        for (const line of describeConfig(updated)) console.info(`  ${line}`);
      } else if (action === "block-term") {
        const current = await repo.get();
        const [mode = "", ...terms] = rest;
        if (mode === "list") {
          log(`Blockliste (${current.blockedTerms.length} Begriffe):`);
          for (const line of describeBlockedTerms(current.blockedTerms)) console.info(`  ${line}`);
          return;
        }
        const next = updateBlockedTerms(current.blockedTerms, mode, terms);
        const updated = await repo.update({ blockedTerms: next }, now);
        log(
          `Blockliste: ${current.blockedTerms.length} → ${updated.blockedTerms.length} Begriffe (wirkt beim nächsten Beitritt)`,
        );
      } else {
        for (const line of describeConfig(await repo.get())) console.info(`  ${line}`);
      }
      return;
    }

    if (area === "game") {
      const dryRun = values["dry-run"];
      const summary = await purgeGamesByCode(client, collections, values.code ?? "", { dryRun });
      for (const line of describePurge(summary, dryRun)) log(line);
      return;
    }

    const bans = createBansRepo(collections.bans);
    if (action === "list") {
      const { bans: active, total } = await bans.listActive(now);
      log(`${total} aktive Sperre(n)${total > active.length ? ` – die neuesten ${active.length}` : ""}:`);
      for (const ban of active) console.info(`  ${describeBanLine(ban)}`);
      return;
    }
    const target = await resolveBanTarget(targetOptions, env.IP_HASH_SECRET, collections);
    if (action === "add") {
      const { ban, extended } = await bans.extend(
        { kind: target.kind, value: target.value, reason: values.reason ?? "", expiresAt },
        now,
      );
      log(
        extended
          ? `${target.label} gesperrt: ${describeBan(ban)} – bestehende Verbindungen trennt Realtime sofort (Change Stream)`
          : `${target.label}: bestehende Sperre ist gleich lang oder länger und bleibt: ${describeBan(ban)}`,
      );
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
