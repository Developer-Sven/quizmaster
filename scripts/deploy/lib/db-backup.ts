/**
 * Datenbank-Sicherung unmittelbar vor einer Aktivierung (ADR-025, docs/04 §Seed & Migrationen).
 *
 * Ein Rollback tauscht nur Code, nie Daten. Realtime ruft beim Start `ensureIndexes()` auf: Indizes anlegen
 * (ein Konflikt bricht den Start ab – auch den des Rollback-Ziels), den `$jsonSchema`-Validator per `collMod`
 * auf den eigenen Stand setzen und `appConfig` ergänzen. Ein Release mit geänderten Schema-Dateien verändert
 * also die Datenbank, und ein späterer Rollback macht das nicht rückgängig (siehe README „Deploy und
 * Rollback“: Expand/Contract). Deshalb sichert der Deploy die Datenbank (`infra/ops/backup.sh --no-files`),
 * wenn sich diese Dateien zwischen laufendem Release und Ziel unterscheiden, beim ersten Release und wenn der
 * Vergleich nicht möglich ist. Testdeploys (`--test-env`, *_test-Datenbank) sichern nicht.
 */
import { join } from "node:path";
import { DeployError } from "./log.ts";
import { run, SYSTEM_PATH } from "./proc.ts";

/** Dateien, deren Änderung beim Start die Datenbank oder das Format gespeicherter Dokumente verändert. */
export const SCHEMA_PATHS: readonly string[] = [
  "packages/db/src/indexes.ts",
  "packages/db/src/validators.ts",
  "packages/db/src/collections.ts",
  "packages/shared/src/documents",
  "scripts/migrations",
];

/**
 * Grund für eine Sicherung oder `null` (nicht nötig). `changed`: geänderte Schema-Dateien zwischen laufendem und
 * Ziel-Release (`null` = Vergleich nicht möglich).
 */
export function backupReason(from: string | null, changed: readonly string[] | null): string | null {
  if (from === null) return "erstes Release";
  if (changed === null) return "Vergleich mit dem laufenden Release nicht möglich";
  if (changed.length === 0) return null;
  const list = changed.slice(0, 3).join(", ") + (changed.length > 3 ? ` (+${changed.length - 3})` : "");
  return `Schema-Dateien geändert: ${list}`;
}

/** `infra/ops/backup.sh --no-files` (verschlüsselt nach /var/backups/quizmaster, Prüfung inklusive). */
export async function runDatabaseBackup(root: string): Promise<void> {
  const result = await run("bash", [join(root, "infra", "ops", "backup.sh"), "--no-files", "--no-alert"], {
    cwd: root,
    // Bewusst schmal: Werkzeuge aus dem System-PATH, Node-Helfer findet backup.sh selbst (.deploy/runtime).
    env: { PATH: SYSTEM_PATH, HOME: process.env.HOME ?? "/root", LANG: process.env.LANG ?? "C.UTF-8" },
    output: "inherit",
    timeoutMs: 3 * 60 * 60_000,
  });
  if (result.timedOut) throw new DeployError("PRE_DEPLOY_BACKUP", "Datenbank-Sicherung: Zeitlimit überschritten");
  if (result.code !== 0) {
    throw new DeployError(
      "PRE_DEPLOY_BACKUP",
      "Datenbank-Sicherung fehlgeschlagen (Ausgabe oben) – nichts wurde umgeschaltet. Ursache beheben; " +
        "nur im Notfall bewusst ohne Sicherung: --skip-backup",
    );
  }
}
