import { describe, expect, it } from "vitest";
import { parseGroup, parsePasswd, resolveServiceIdentity, SERVICE_USER, userNameOf } from "./service-user.cjs";

// Synthetische Kontodatenbanken – die Auflösung entscheidet, ob pm2 die Apps als root startet (fail closed).
const PASSWD = [
  "root:x:0:0:root:/root:/bin/bash",
  "# Kommentar",
  "",
  "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
  "_apt:x:100:65534::/nonexistent:/usr/sbin/nologin",
  "quizmaster:x:997:997:quizmaster (pm2-Apps):/nonexistent:/usr/sbin/nologin",
  "+nisuser::::::",
  "kaputt:x:abc:1::/:/bin/false",
  "kurz:x:5",
].join("\n");
const GROUP = ["root:x:0:", "nogroup:x:65534:", "quizmaster:x:997:", "users:x:100:alice,bob"].join("\n");

const resolve = (options: { user: string; passwd?: string; group?: string; required?: boolean; shared?: boolean }) =>
  resolveServiceIdentity({
    user: options.user,
    passwd: options.passwd ?? PASSWD,
    group: options.group ?? GROUP,
    required: options.required,
    allowSharedGroup: options.shared,
  });

describe("parsePasswd / parseGroup", () => {
  it("überspringen Kommentare, Leerzeilen, NIS-Einträge und zu kurze Zeilen; CRLF und ungültige Zahlen", () => {
    const entries = parsePasswd(`${PASSWD}\r\nwin:x:12:13::/home/win:/bin/sh\r\n`);
    expect(entries.map((entry) => entry.name)).toEqual(["root", "nobody", "_apt", "quizmaster", "kaputt", "win"]);
    expect(entries.find((entry) => entry.name === "kaputt")).toMatchObject({ uid: null, gid: 1 });
    expect(entries.find((entry) => entry.name === "win")).toMatchObject({ uid: 12, gid: 13, shell: "/bin/sh" });
    expect(parsePasswd("big:x:4294967295:1::/:/bin/sh\n")[0]?.uid).toBeNull();
    expect(parsePasswd("neg:x:-1:1::/:/bin/sh\n")[0]?.uid).toBeNull();
    expect(parseGroup(GROUP).find((entry) => entry.name === "users")?.members).toEqual(["alice", "bob"]);
    expect(userNameOf(997, PASSWD)).toBe("quizmaster");
    expect(userNameOf(4242, PASSWD)).toBeNull();
  });
});

describe("resolveServiceIdentity", () => {
  it("vorhandener Dienstbenutzer mit exklusiver Gruppe → uid/gid, Gruppe und Home", () => {
    expect(resolve({ user: SERVICE_USER })).toEqual({
      kind: "service",
      user: "quizmaster",
      uid: 997,
      gid: 997,
      group: "quizmaster",
      home: "/nonexistent",
      shell: "/usr/sbin/nologin",
      sharedWith: [],
    });
  });

  it("fehlender Benutzer → Rückfall root (uid/gid 0); verlangt (Testmodus) → Fehler", () => {
    const passwd = PASSWD.split("\n")
      .filter((line) => !line.startsWith("quizmaster:"))
      .join("\n");
    expect(resolve({ user: SERVICE_USER, passwd })).toEqual({
      kind: "root",
      user: "quizmaster",
      uid: 0,
      gid: 0,
      reason: "Benutzer quizmaster existiert nicht",
    });
    expect(() => resolve({ user: "fehlt", required: true })).toThrow(/existiert nicht/);
  });

  it("uid/gid 0, ungültige Felder, fehlende Gruppe oder doppelte uid → Fehler statt root", () => {
    const swap = (line: string) => PASSWD.replace(/^quizmaster:.*$/m, line);
    expect(() => resolve({ user: SERVICE_USER, passwd: swap("quizmaster:x:0:997::/:/usr/sbin/nologin") })).toThrow(
      /0 wäre root/,
    );
    expect(() => resolve({ user: SERVICE_USER, passwd: swap("quizmaster:x:997:0::/:/usr/sbin/nologin") })).toThrow(
      /0 wäre root/,
    );
    expect(() => resolve({ user: "kaputt" })).toThrow(/keine gültige uid/);
    expect(() => resolve({ user: SERVICE_USER, group: "root:x:0:" })).toThrow(/primäre Gruppe 997 .* fehlt/);
    expect(() => resolve({ user: SERVICE_USER, passwd: `${PASSWD}\ntwin:x:997:4::/:/bin/sh` })).toThrow(
      /gehört auch twin/,
    );
    expect(() => resolve({ user: "Root;rm" })).toThrow(/ungültiger Benutzername/);
  });

  it("nicht exklusive Gruppe → Fehler (Env-Dateien wären lesbar); nur Tests dürfen sie zulassen", () => {
    expect(() =>
      resolve({ user: SERVICE_USER, group: GROUP.replace("quizmaster:x:997:", "quizmaster:x:997:www-data") }),
    ).toThrow(/nicht exklusiv für quizmaster \(auch: www-data\)/);
    expect(() => resolve({ user: "nobody", required: true })).toThrow(/auch: _apt/);
    const nobody = resolve({ user: "nobody", required: true, shared: true });
    expect(nobody).toMatchObject({ kind: "service", uid: 65534, gid: 65534, group: "nogroup", sharedWith: ["_apt"] });
    // Der Benutzer selbst als Mitglied seiner Gruppe zählt nicht als geteilt.
    expect(
      resolve({ user: SERVICE_USER, group: GROUP.replace("quizmaster:x:997:", "quizmaster:x:997:quizmaster") }),
    ).toMatchObject({ sharedWith: [] });
  });
});
