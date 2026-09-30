/**
 * Hilfen für mongodump/mongorestore (infra/ops/backup.sh, restore-test.sh).
 *
 * - Die URI gelangt nie auf die Kommandozeile: die Werkzeuge lesen sie über `--config` (YAML) aus einer Pipe.
 * - `authSource` wird explizit gesetzt, wie der Node-Treiber ihn ableitet (URI-Pfad, sonst `admin`): ohne
 *   Angabe nehmen die Mongo-Tools die mit `--db` gewählte Datenbank als Auth-Datenbank – die Anmeldung
 *   schlägt dann fehl (geprüft mit mongodump 100.17).
 * - Die Log-Zeilen der Werkzeuge liefern die Dokumentzahlen je Collection (Manifest, Restore-Vergleich).
 */

const URI_PATTERN = /^(mongodb(?:\+srv)?:\/\/)([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?$/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Ergänzt `authSource`, falls die URI Zugangsdaten, aber keinen `authSource` enthält und ein SCRAM-Verfahren
 * (Standard) nutzt. `txtAuthSource`: Wert aus dem DNS-TXT-Eintrag einer `mongodb+srv://`-URI (hat Vorrang
 * vor dem Standard, wie beim Treiber).
 */
export function withExplicitAuthSource(uri: string, txtAuthSource: string | null = null): string {
  const match = URI_PATTERN.exec(uri.trim());
  if (!match) throw new Error("keine gültige mongodb://- bzw. mongodb+srv://-URI");
  const scheme = match[1] ?? "";
  const authority = match[2] ?? "";
  const path = match[3] ?? "";
  const params = (match[4] ?? "").split(/[&;]/).filter((part) => part !== "");
  const keys = params.map((part) => safeDecode(part.split("=")[0] ?? "").toLowerCase());
  if (!authority.includes("@") || keys.includes("authsource")) return uri.trim();
  const mechanismIndex = keys.indexOf("authmechanism");
  if (mechanismIndex !== -1) {
    const mechanism = safeDecode(params[mechanismIndex]?.split("=")[1] ?? "").toUpperCase();
    // X.509, GSSAPI, AWS, OIDC, PLAIN authentifizieren gegen $external – dort nichts ergänzen.
    if (!mechanism.startsWith("SCRAM-")) return uri.trim();
  }
  const pathDb = safeDecode(path.replace(/^\//, ""));
  const authSource = txtAuthSource ?? (pathDb !== "" ? pathDb : "admin");
  params.push(`authSource=${encodeURIComponent(authSource)}`);
  return `${scheme}${authority}${path === "" ? "/" : path}?${params.join("&")}`;
}

/** Host einer `mongodb+srv://`-URI (für den TXT-Lookup) oder null. */
export function srvHost(uri: string): string | null {
  const match = /^mongodb\+srv:\/\/(?:[^@/?#]*@)?([^/?#:,]+)/.exec(uri.trim());
  return match?.[1] ?? null;
}

/** `authSource` aus TXT-Einträgen (`authSource=admin&replicaSet=…`). */
export function authSourceFromTxt(records: readonly (readonly string[])[]): string | null {
  for (const record of records) {
    for (const part of record.join("").split("&")) {
      const [key, value] = part.split("=");
      if (key?.toLowerCase() === "authsource" && value) return safeDecode(value);
    }
  }
  return null;
}

/** YAML für `--config` (JSON-Strings sind gültige YAML-Skalare in doppelten Anführungszeichen). */
export function mongoToolsConfig(uri: string): string {
  return `uri: ${JSON.stringify(uri)}\n`;
}

/** `done dumping \`db.coll\` (N documents)` → Map Namespace → Anzahl. */
export function parseDumpLog(log: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of log.matchAll(/done dumping `([^`]+)` \((\d+) documents?\)/g)) {
    counts.set(match[1] ?? "", Number.parseInt(match[2] ?? "0", 10));
  }
  return counts;
}

export interface RestoreSummary {
  collections: Map<string, { documents: number; failures: number }>;
  restored: number | null;
  failed: number | null;
}

/** `finished restoring \`db.coll\` (N documents, F failures)` + Summenzeile. */
export function parseRestoreLog(log: string): RestoreSummary {
  const collections = new Map<string, { documents: number; failures: number }>();
  for (const match of log.matchAll(/finished restoring `([^`]+)` \((\d+) documents?, (\d+) failures?\)/g)) {
    collections.set(match[1] ?? "", {
      documents: Number.parseInt(match[2] ?? "0", 10),
      failures: Number.parseInt(match[3] ?? "0", 10),
    });
  }
  const total = /(\d+) document\(s\) restored successfully\. (\d+) document\(s\) failed to restore\./.exec(log);
  return {
    collections,
    restored: total ? Number.parseInt(total[1] ?? "0", 10) : null,
    failed: total ? Number.parseInt(total[2] ?? "0", 10) : null,
  };
}

/** `db.coll` → `coll` (nur für die angegebene Datenbank; sonst null). */
export function collectionOf(namespace: string, database: string): string | null {
  return namespace.startsWith(`${database}.`) ? namespace.slice(database.length + 1) : null;
}

/** Präfix der Restore-Test-Collections: `rt` + 12 Ziffern (UTC yymmddHHMMSS) + `_`. */
export const RESTORE_PREFIX_PATTERN = /^rt\d{12}_$/;

/** Präfix für einen Restore-Test zum Zeitpunkt `date` (UTC). */
export function restorePrefix(date = new Date()): string {
  const iso = date.toISOString(); // 2026-10-01T02:30:00.000Z
  return `rt${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}_`;
}

/** Zeitpunkt aus einem Restore-Präfix (null bei ungültigem Präfix). */
export function restorePrefixDate(prefix: string): Date | null {
  const match = /^rt(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_$/.exec(prefix);
  if (!match) return null;
  const [, yy, mo, dd, hh, mi, ss] = match;
  const date = new Date(`20${yy}-${mo}-${dd}T${hh}:${mi}:${ss}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
