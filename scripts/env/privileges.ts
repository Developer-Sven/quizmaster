/**
 * Auswertung der Rechte des Datenbank-Benutzers für `env:check --connect` (docs/04 §Datenbank-Benutzer,
 * docs/06: Least Privilege – die Apps brauchen nur `readWrite` auf ihrer Datenbank). Erkennt fehlende
 * Rechte UND überzählige (dbOwner, userAdmin, root, fremde Datenbanken), damit ein zu mächtiger Benutzer
 * nicht still als „readWrite ok“ durchgeht.
 */

/** Eintrag aus `connectionStatus` (`authInfo.authenticatedUserPrivileges`). */
export interface Privilege {
  resource?: { db?: string; collection?: string; anyResource?: boolean; cluster?: boolean };
  actions?: string[];
}

/** Was die Apps und der Seed auf ihrer Datenbank brauchen (Teil von `readWrite`). */
export const REQUIRED_ACTIONS = [
  "find",
  "insert",
  "update",
  "remove",
  "createCollection",
  "createIndex",
  "changeStream",
] as const;

/** Rechte über `readWrite` hinaus, die weder App noch Seed je brauchen (dbOwner/dbAdmin/userAdmin). */
export const EXCESSIVE_ACTIONS: readonly string[] = [
  "dropDatabase",
  "createUser",
  "dropUser",
  "changePassword",
  "changeCustomData",
  "createRole",
  "dropRole",
  "grantRole",
  "revokeRole",
  "setAuthenticationRestriction",
  "enableProfiler",
];

export interface PrivilegeReport {
  /** Fehlende `REQUIRED_ACTIONS` je erwarteter Datenbank (leer = vorhanden). */
  missing: Map<string, string[]>;
  /** Datenbanken mit `collMod` (Validator-Update durch `ensureIndexes`) – nur Info, kein Fehler. */
  collMod: Set<string>;
  /** Überzählige Rechte (sortiert, ohne Werte/Zugangsdaten). */
  excessive: string[];
}

/** Prüft die Rechte gegen die erwarteten Datenbanken (`MONGODB_DB`, in dev zusätzlich `TEST_MONGODB_DB`). */
export function assessPrivileges(privileges: readonly Privilege[], databases: readonly string[]): PrivilegeReport {
  const missing = new Map<string, string[]>();
  const collMod = new Set<string>();
  for (const db of databases) {
    const granted = new Set<string>();
    for (const privilege of privileges) {
      const resource = privilege.resource ?? {};
      const matches =
        resource.anyResource === true ||
        ((resource.db === db || resource.db === "") && (resource.collection ?? "") === "");
      if (matches) for (const action of privilege.actions ?? []) granted.add(action);
    }
    const all = granted.has("anyAction");
    missing.set(
      db,
      REQUIRED_ACTIONS.filter((action) => !all && !granted.has(action)),
    );
    if (all || granted.has("collMod")) collMod.add(db);
  }

  const excessive = new Set<string>();
  const expected = new Set(databases);
  for (const privilege of privileges) {
    const resource = privilege.resource ?? {};
    const actions = privilege.actions ?? [];
    if (resource.anyResource === true) excessive.add("Rechte auf alle Ressourcen (anyResource)");
    else if (resource.cluster === true) excessive.add(`Cluster-Rechte (${[...actions].sort().join(", ")})`);
    else if (resource.db === "" && (resource.collection ?? "") === "") excessive.add("Rechte auf alle Datenbanken");
    else if (resource.db !== undefined && resource.db !== "" && !expected.has(resource.db)) {
      excessive.add(`Rechte auf fremde Datenbank ${resource.db}`);
    }
    const scope = resource.db === undefined || resource.db === "" ? "*" : resource.db;
    for (const action of actions) {
      if (EXCESSIVE_ACTIONS.includes(action)) excessive.add(`${action}@${scope}`);
    }
  }
  return { missing, collMod, excessive: [...excessive].sort() };
}
