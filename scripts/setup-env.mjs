#!/usr/bin/env node
// Legt .env.dev / .env.prod aus den Vorlagen an und erzeugt alle Secrets.
//
//   pnpm setup:env dev
//   pnpm setup:env prod --domain quiz.example.com --port 7400 --tls-cert /pfad/cert.pem --tls-key /pfad/key.pem
//   pnpm setup:env prod --rotate SESSION_SECRET     # ein Secret neu erzeugen
//   pnpm setup:env dev --add-missing                # neue Schlüssel aus der Vorlage ergänzen
//   pnpm setup:env prod --set TURNSTILE_ENABLED=true # einen Schalter umlegen (nur SWITCHES, ohne die Datei zu zeigen)
//
// Grundsätze: überschreibt nie bestehende Werte (außer --rotate für genau einen Schlüssel bzw. --set für Schalter),
// schreibt atomar mit Rechten 600 und gibt niemals Werte aus – nur Schlüsselnamen.
// Bewusst ohne Abhängigkeiten, damit es vor `pnpm install` und mit jeder Node-Version ≥ 22 läuft.

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENVIRONMENTS = new Set(["dev", "prod"]);
const SECRET_KEYS = new Set([
  "SESSION_SECRET",
  "REALTIME_TICKET_SECRET",
  "IP_HASH_SECRET",
  "METRICS_TOKEN",
  "BACKUP_PASSPHRASE",
]);
const KEY_LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;
/** Nicht geheime Schalter, die `--set` umlegen darf – mit erlaubten Werten (Schema: packages/shared/src/env). */
const SWITCHES = new Map([
  ["TURNSTILE_ENABLED", ["true", "false"]],
  ["SEARCH_INDEXING", ["true", "false"]],
  ["LOG_LEVEL", ["fatal", "error", "warn", "info", "debug", "trace", "silent"]],
]);

function fail(message) {
  console.error(`setup:env – ${message}`);
  process.exit(1);
}

function newSecret() {
  return randomBytes(32).toString("base64url");
}

function parseCli() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      domain: { type: "string" },
      port: { type: "string" },
      "realtime-port": { type: "string" },
      "tls-cert": { type: "string" },
      "tls-key": { type: "string" },
      rotate: { type: "string" },
      "add-missing": { type: "boolean", default: false },
      set: { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length !== 1 || !ENVIRONMENTS.has(positionals[0])) {
    console.log(
      "Aufruf: setup-env.mjs <dev|prod> [--domain D] [--port P] [--realtime-port P] [--tls-cert F] [--tls-key F]\n" +
        "        setup-env.mjs <dev|prod> --rotate <SECRET_KEY>\n" +
        "        setup-env.mjs <dev|prod> --add-missing\n" +
        `        setup-env.mjs <dev|prod> --set KEY=WERT [--set …]   (KEY: ${[...SWITCHES.keys()].join(", ")})`,
    );
    process.exit(values.help ? 0 : 1);
  }
  return { env: positionals[0], opts: values };
}

function validateOverrides(opts) {
  const overrides = new Map();
  if (opts.domain !== undefined) {
    const domain = opts.domain.trim().toLowerCase();
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))
      fail(`ungültige Domain: ${opts.domain}`);
    overrides.set("QUIZMASTER_DOMAIN", domain);
  }
  for (const [flag, key] of [
    ["port", "QUIZMASTER_PORT"],
    ["realtime-port", "REALTIME_PORT"],
  ]) {
    if (opts[flag] === undefined) continue;
    const port = Number(opts[flag]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) fail(`--${flag} muss zwischen 1024 und 65535 liegen`);
    overrides.set(key, String(port));
  }
  for (const [flag, key] of [
    ["tls-cert", "TLS_CERT_FILE"],
    ["tls-key", "TLS_KEY_FILE"],
  ]) {
    if (opts[flag] === undefined) continue;
    if (!isAbsolute(opts[flag]) || /\s/.test(opts[flag]))
      fail(`--${flag} braucht einen absoluten Pfad ohne Leerzeichen`);
    if (!existsSync(opts[flag])) console.warn(`setup:env – Hinweis: ${opts[flag]} existiert (noch) nicht`);
    overrides.set(key, opts[flag]);
  }
  return overrides;
}

function writeAtomic(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

function readLines(file) {
  return readFileSync(file, "utf8").split("\n");
}

function create(env, examplePath, targetPath, overrides) {
  const report = [];
  const out = readLines(examplePath).map((line) => {
    const match = KEY_LINE.exec(line);
    if (!match) return line;
    const [, key, value] = match;
    if (overrides.has(key)) {
      report.push(`${key}: gesetzt`);
      return `${key}=${overrides.get(key)}`;
    }
    if (SECRET_KEYS.has(key) && value === "") {
      report.push(`${key}: erzeugt`);
      return `${key}=${newSecret()}`;
    }
    return line;
  });
  writeAtomic(targetPath, out.join("\n"));
  console.log(`setup:env – .env.${env} angelegt (Rechte 600):`);
  for (const line of report) console.log(`  ${line}`);
  const todo = out.filter((line) =>
    /^(MONGODB_URI|TURNSTILE_SITE_KEY|TURNSTILE_SECRET_KEY|ALERT_WEBHOOK_URL)=$/.test(line),
  );
  if (todo.length > 0) console.log(`  noch leer: ${todo.map((line) => line.slice(0, -1)).join(", ")}`);
}

function rotate(env, targetPath, key) {
  if (!SECRET_KEYS.has(key)) fail(`${key} ist kein rotierbares Secret (${[...SECRET_KEYS].join(", ")})`);
  let found = false;
  const out = readLines(targetPath).map((line) => {
    const match = KEY_LINE.exec(line);
    if (!match || match[1] !== key) return line;
    found = true;
    return `${key}=${newSecret()}`;
  });
  if (!found) fail(`${key} fehlt in .env.${env} – erst mit --add-missing ergänzen`);
  writeAtomic(targetPath, out.join("\n"));
  console.log(
    `setup:env – ${key} in .env.${env} neu erzeugt. Betroffene Apps neu starten (siehe README „Secrets rotieren“).`,
  );
}

function addMissing(env, examplePath, targetPath) {
  const current = readLines(targetPath);
  const present = new Set(current.map((line) => KEY_LINE.exec(line)?.[1]).filter(Boolean));
  const additions = [];
  for (const line of readLines(examplePath)) {
    const match = KEY_LINE.exec(line);
    if (!match || present.has(match[1])) continue;
    const [, key, value] = match;
    additions.push(SECRET_KEYS.has(key) && value === "" ? `${key}=${newSecret()}` : line);
  }
  if (additions.length === 0) {
    console.log(`setup:env – .env.${env} ist vollständig.`);
    return;
  }
  const body = current.join("\n").replace(/\n*$/, "\n");
  writeAtomic(targetPath, `${body}\n# ── ergänzt durch setup:env --add-missing ──\n${additions.join("\n")}\n`);
  console.log(`setup:env – ergänzt: ${additions.map((line) => line.split("=")[0]).join(", ")}`);
}

function parseSwitches(assignments) {
  const changes = new Map();
  for (const assignment of assignments) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(assignment);
    if (!match) fail(`--set erwartet KEY=WERT (${assignment.split("=")[0]})`);
    const [, key, value] = match;
    const allowed = SWITCHES.get(key);
    if (!allowed)
      fail(`${key} ist kein Schalter für --set (${[...SWITCHES.keys()].join(", ")}) – Werte trägst du selbst ein`);
    if (!allowed.includes(value)) fail(`${key} erlaubt nur ${allowed.join(" | ")}`);
    if (changes.has(key)) fail(`${key} mehrfach angegeben`);
    changes.set(key, value);
  }
  return changes;
}

function setSwitches(env, targetPath, changes) {
  const seen = new Set();
  const report = [];
  const out = readLines(targetPath).map((line) => {
    const match = KEY_LINE.exec(line);
    if (!match || !changes.has(match[1])) return line;
    const [, key, current] = match;
    seen.add(key);
    report.push(current === changes.get(key) ? `${key}=${current} (unverändert)` : `${key}=${changes.get(key)}`);
    return `${key}=${changes.get(key)}`;
  });
  const missing = [...changes.keys()].filter((key) => !seen.has(key));
  if (missing.length > 0) fail(`${missing.join(", ")} fehlt in .env.${env} – erst mit --add-missing ergänzen`);
  writeAtomic(targetPath, out.join("\n"));
  console.log(`setup:env – .env.${env}: ${report.join(", ")}`);
  console.log(
    env === "prod"
      ? "  Wirksam nach `pnpm deploy:restart` (betroffene Apps neu starten, README „Betrieb“)."
      : "  Wirksam nach einem Neustart von `pnpm dev`.",
  );
}

const { env, opts } = parseCli();
const examplePath = join(ROOT, `.env.${env}.example`);
const targetPath = join(ROOT, `.env.${env}`);
if (!existsSync(examplePath)) fail(`Vorlage .env.${env}.example fehlt`);

const modes = [opts.rotate !== undefined, opts["add-missing"], opts.set !== undefined].filter(Boolean).length;
if (modes > 1) fail("--rotate, --add-missing und --set nur einzeln verwenden");

if (opts.set) {
  if (!existsSync(targetPath)) fail(`.env.${env} existiert nicht`);
  setSwitches(env, targetPath, parseSwitches(opts.set));
} else if (opts.rotate) {
  if (!existsSync(targetPath)) fail(`.env.${env} existiert nicht`);
  rotate(env, targetPath, opts.rotate);
} else if (opts["add-missing"]) {
  if (!existsSync(targetPath)) fail(`.env.${env} existiert nicht`);
  addMissing(env, examplePath, targetPath);
} else {
  if (existsSync(targetPath)) {
    console.log(
      `setup:env – .env.${env} existiert bereits und wird nicht überschrieben (--add-missing / --rotate KEY).`,
    );
    process.exit(0);
  }
  create(env, examplePath, targetPath, validateOverrides(opts));
}
