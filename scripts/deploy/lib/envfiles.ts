/**
 * Env-Dateien je App (ADR-022, ADR-024): aus `.env.prod` über `webProcessEnv`/`realtimeProcessEnv`/
 * `watchdogProcessEnv` (einzige Quelle für Ableitungen und Schlüssel je App) plus `RELEASE=<sha>`.
 *
 * Die Werte werden roh geschrieben (keine Interpolation – Node liest `--env-file` ohne `$VAR`-Expansion).
 * Wo ein Wert Zeichen enthält, die der Parser sonst deuten würde (`#`, Leerzeichen, Anführungszeichen),
 * wird er in ein Anführungszeichen gesetzt, das Node wörtlich liest. Jede Datei wird vor dem Schreiben mit
 * `util.parseEnv` (derselbe Parser wie `--env-file`) zurückgelesen und muss exakt übereinstimmen.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { type ResolvedEnv, realtimeProcessEnv, watchdogProcessEnv, webProcessEnv } from "@quizmaster/shared/env";
import type { AppKey } from "./layout.ts";
import { DeployError } from "./log.ts";

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
/** Zeichen, die ungequotet eindeutig sind (kein `#`, keine Leerzeichen, keine Quotes, kein Backslash). */
const RAW_SAFE = /^[A-Za-z0-9_@%+=:,./~^!*?&$|<>()[\]{}-]*$/;

/** Ein Wert in der Form, die `--env-file` exakt so zurückliest. */
export function serializeEnvValue(key: string, value: string): string {
  if (!KEY_PATTERN.test(key)) throw new DeployError("ENV_KEY_INVALID", `ungültiger Schlüsselname ${key}`);
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new DeployError("ENV_VALUE_UNSUPPORTED", `${key}: mehrzeilige Werte werden nicht unterstützt`);
  }
  if (RAW_SAFE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  if (!value.includes("`")) return `\`${value}\``;
  throw new DeployError("ENV_VALUE_UNSUPPORTED", `${key}: Wert lässt sich nicht verlustfrei als Env-Datei schreiben`);
}

/** Serialisiert und prüft per Rücklesen; `header` sind Kommentarzeilen ohne Werte. */
export function serializeEnv(entries: Readonly<Record<string, string>>, header: readonly string[] = []): string {
  const lines = header.map((line) => `# ${line}`.trimEnd());
  for (const [key, value] of Object.entries(entries)) lines.push(`${key}=${serializeEnvValue(key, value)}`);
  const text = `${lines.join("\n")}\n`;
  const parsed = parseEnv(text);
  const expectedKeys = Object.keys(entries).sort();
  const actualKeys = Object.keys(parsed).sort();
  const same =
    expectedKeys.length === actualKeys.length &&
    expectedKeys.every((key, index) => key === actualKeys[index] && parsed[key] === entries[key]);
  if (!same) {
    const broken = expectedKeys.filter((key) => parsed[key] !== entries[key]);
    throw new DeployError(
      "ENV_ROUNDTRIP",
      `Env-Datei würde anders gelesen als geschrieben (${broken.join(", ") || "Schlüsselmenge"})`,
    );
  }
  return text;
}

/** Laufzeit-Env einer App für ein Release – ausschließlich aus @quizmaster/shared/env abgeleitet. */
export function appEnv(resolved: ResolvedEnv, app: AppKey, sha: string): Record<string, string> {
  const base =
    app === "web"
      ? webProcessEnv(resolved)
      : app === "realtime"
        ? realtimeProcessEnv(resolved)
        : watchdogProcessEnv(resolved);
  return { ...base, RELEASE: sha };
}

/** `sourceLabel` nennt die Quelle im Kopfkommentar (Dateiname, nie Werte). */
export function renderAppEnvFile(resolved: ResolvedEnv, app: AppKey, sha: string, sourceLabel: string): string {
  return serializeEnv(appEnv(resolved, app, sha), [
    `quizmaster ${app} – erzeugt von scripts/deploy aus ${sourceLabel} (Release ${sha.slice(0, 12)})`,
    "Nicht bearbeiten: Änderungen in .env.prod vornehmen, dann `pnpm deploy:restart`.",
  ]);
}

/** Schreibt eine Datei atomar mit Rechten 600 (Verzeichnis 700). */
export function writePrivateFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${Date.now()}-${process.pid}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Liest nur `RELEASE` aus einer erzeugten Env-Datei (für Status-Ausgaben). */
export function readRelease(path: string): string | null {
  if (!existsSync(path)) return null;
  return parseEnv(readFileSync(path, "utf8")).RELEASE ?? null;
}
