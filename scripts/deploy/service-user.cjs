// Dienstbenutzer der quizmaster-Apps (docs/12 „Nicht-Root-User“, README „Systembenutzer“). Gemeinsam genutzt von
// ecosystem.config.js (läuft im pm2-CLI auf dem System-Node, CommonJS) und dem Deploy-Werkzeug (Node 24) – beide
// müssen dieselbe uid/gid sehen. Angelegt wird der Benutzer von infra/ops/create-user.sh.
//
// Aufgelöst wird wie in pm2 selbst (lib/tools/passwd.js) über /etc/passwd und /etc/group. Regeln (fail closed):
//   - Benutzer fehlt → Rückfall auf root (Stand vor der Umstellung, der Deploy warnt) – außer der Benutzer wurde
//     ausdrücklich verlangt (`required`, Testmodus `--test-user`) → Fehler
//   - uid oder gid 0, ungültige Einträge, fehlende primäre Gruppe oder eine zweite Kennung mit derselben uid → Fehler,
//     nie stillschweigend root
//   - primäre Gruppe nicht exklusiv (weitere Mitglieder oder primäre Gruppe anderer Konten) → Fehler, weil die
//     Env-Dateien für diese Gruppe lesbar sind; nur Tests des Deploy-Werkzeugs dürfen das zulassen (nobody/nogroup)
"use strict";

const fs = require("node:fs");

/** Name des Dienstbenutzers und seiner Gruppe in Produktion. */
const SERVICE_USER = "quizmaster";
/** Home ohne Verzeichnis (Debian-Konvention für Systembenutzer, wie bei nobody). */
const NO_HOME = "/nonexistent";

const NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const ID_PATTERN = /^\d{1,10}$/;
/** (uid_t)-1 bzw. (gid_t)-1 sind keine gültigen Kennungen. */
const MAX_ID = 0xfffffffe;

/** Zeilen einer Kontodatenbank (passwd/group), ohne Leerzeilen, Kommentare und NIS-Einträge (+/-). */
function parseLines(text, minFields) {
  const rows = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "" || line.startsWith("#") || line.startsWith("+") || line.startsWith("-")) continue;
    const fields = line.split(":");
    if (fields.length >= minFields) rows.push(fields);
  }
  return rows;
}

/** Kennung aus einem Feld oder null, wenn sie keine gültige uid/gid ist. */
function toId(value) {
  if (!ID_PATTERN.test(value)) return null;
  const id = Number(value);
  return id <= MAX_ID ? id : null;
}

/** Einträge aus /etc/passwd: name, uid, gid (null bei ungültigen Feldern), home, shell. */
function parsePasswd(text) {
  return parseLines(text, 7).map((fields) => ({
    name: fields[0],
    uid: toId(fields[2]),
    gid: toId(fields[3]),
    home: fields[5],
    shell: fields[6],
  }));
}

/** Einträge aus /etc/group: name, gid (null bei ungültigem Feld), members. */
function parseGroup(text) {
  return parseLines(text, 4).map((fields) => ({
    name: fields[0],
    gid: toId(fields[2]),
    members: fields[3]
      .split(",")
      .map((member) => member.trim())
      .filter((member) => member !== ""),
  }));
}

/**
 * Identität, unter der pm2 die Apps startet: `{ kind: "service", … }` oder – nur wenn der Benutzer fehlt und nicht
 * verlangt ist – `{ kind: "root", uid: 0, gid: 0 }`. Wirft bei allem, was nicht eindeutig sicher ist.
 */
function resolveServiceIdentity(options) {
  const user = options.user;
  if (typeof user !== "string" || !NAME_PATTERN.test(user)) {
    throw new Error(`ungültiger Benutzername „${String(user)}“`);
  }
  const users = parsePasswd(options.passwd);
  const entry = users.find((candidate) => candidate.name === user);
  if (entry === undefined) {
    if (options.required === true) throw new Error(`Benutzer ${user} existiert nicht (/etc/passwd)`);
    return { kind: "root", user, uid: 0, gid: 0, reason: `Benutzer ${user} existiert nicht` };
  }
  if (entry.uid === null || entry.gid === null) {
    throw new Error(`Eintrag von ${user} in /etc/passwd hat keine gültige uid/gid`);
  }
  if (entry.uid === 0 || entry.gid === 0) {
    throw new Error(`${user} hat uid ${entry.uid}, gid ${entry.gid} – 0 wäre root; Eintrag in /etc/passwd prüfen`);
  }
  const aliases = users.filter((other) => other.name !== user && other.uid === entry.uid).map((other) => other.name);
  if (aliases.length > 0) {
    throw new Error(`uid ${entry.uid} von ${user} gehört auch ${aliases.join(", ")} – eigene uid nötig`);
  }
  const group = parseGroup(options.group).find((candidate) => candidate.gid === entry.gid);
  if (group === undefined) throw new Error(`primäre Gruppe ${entry.gid} von ${user} fehlt in /etc/group`);
  const sharedWith = [
    ...new Set([
      ...users.filter((other) => other.name !== user && other.gid === entry.gid).map((other) => other.name),
      ...group.members.filter((member) => member !== user),
    ]),
  ].sort();
  if (sharedWith.length > 0 && options.allowSharedGroup !== true) {
    throw new Error(
      `Gruppe ${group.name} (gid ${entry.gid}) ist nicht exklusiv für ${user} (auch: ${sharedWith.join(", ")}) – ` +
        "die Env-Dateien wären für diese Konten lesbar",
    );
  }
  return {
    kind: "service",
    user,
    uid: entry.uid,
    gid: entry.gid,
    group: group.name,
    home: entry.home === "" ? NO_HOME : entry.home,
    shell: entry.shell,
    sharedWith,
  };
}

/** Liest einen Systemkatalog; jeder Fehler bricht ab (ohne Katalog ist nicht entscheidbar, ob root droht). */
function readDatabase(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${path} nicht lesbar (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Wie resolveServiceIdentity, mit den Systemdateien /etc/passwd und /etc/group. */
function readServiceIdentity(options) {
  return resolveServiceIdentity({
    user: options.user,
    required: options.required,
    allowSharedGroup: options.allowSharedGroup,
    passwd: readDatabase("/etc/passwd"),
    group: readDatabase("/etc/group"),
  });
}

/** Name zu einer uid laut /etc/passwd (für Statusausgaben) oder null. */
function userNameOf(uid, passwd) {
  return parsePasswd(passwd).find((entry) => entry.uid === uid)?.name ?? null;
}

module.exports = {
  NO_HOME,
  SERVICE_USER,
  parseGroup,
  parsePasswd,
  readServiceIdentity,
  resolveServiceIdentity,
  userNameOf,
};
