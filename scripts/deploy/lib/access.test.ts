import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceIdentity } from "../service-user.cjs";
import {
  bitsFor,
  CACHE_DIR_MODE,
  canModify,
  canReplaceEntries,
  deployChain,
  deployIdentity,
  ensureWebCache,
  envAccess,
  identityMismatch,
  mongoUriFiles,
  parseProcStatus,
  pathProblems,
  prepareAccess,
  R,
  readProcStatus,
  removeTree,
  traversedDirectories,
  treeProblems,
  webCacheDir,
  X,
} from "./access.ts";
import { envFile, type Layout, layoutFor, releaseDir } from "./layout.ts";

const me = deployIdentity();
/** Fremde uid, eigene Gruppe: Rechte wirken über die Gruppen-Bits (ohne root testbar). */
const groupPeer = { uid: me.uid + 1, gid: me.gid };
const isRoot = me.uid === 0;
const SHA = "a".repeat(40);

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "qm-access-test-"));
  chmodSync(dir, 0o755);
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Minimales Layout mit Release (Web-Einstieg, .next) und Node-Laufzeit. */
function fixture(mode: "prod" | "test" = "prod"): Layout {
  const layout = layoutFor(scratch(), mode);
  mkdirSync(layout.deployDir, { recursive: true, mode: 0o700 });
  const web = join(releaseDir(layout, SHA), "web", "apps", "web");
  mkdirSync(join(web, ".next", "static"), { recursive: true });
  writeFileSync(join(web, "server.js"), "// server\n");
  mkdirSync(join(releaseDir(layout, SHA), "realtime", "dist"), { recursive: true });
  writeFileSync(join(releaseDir(layout, SHA), "realtime", "dist", "index.mjs"), "// realtime\n");
  const dist = join(layout.runtimeDir, "node-v24.0.0-linux-x64", "bin");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "node"), "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync("node-v24.0.0-linux-x64", join(layout.runtimeDir, "node"));
  return layout;
}

const service = (uid: number, gid: number, user = "svc"): ServiceIdentity => ({
  kind: "service",
  user,
  uid,
  gid,
  group: user,
  home: "/nonexistent",
  shell: "/usr/sbin/nologin",
  sharedWith: [],
});
const ROOT_FALLBACK: ServiceIdentity = { kind: "root", user: "quizmaster", uid: 0, gid: 0, reason: "Test" };

describe("Rechte-Auswertung wie der Kernel (ohne Zusatzgruppen)", () => {
  const stat = (uid: number, gid: number, mode: number) => ({ uid, gid, mode });

  it("Besitzer vor Gruppe vor andere; root darf alles", () => {
    expect(bitsFor(stat(5, 6, 0o047), { uid: 5, gid: 6 })).toBe(0); // Besitzer: keine Rechte, trotz Gruppe
    expect(bitsFor(stat(5, 6, 0o750), { uid: 7, gid: 6 })).toBe(5);
    expect(bitsFor(stat(5, 6, 0o751), { uid: 7, gid: 8 })).toBe(1);
    expect(bitsFor(stat(5, 6, 0o000), { uid: 0, gid: 0 })).toBe(7);
  });

  it("veränderbar: als Besitzer oder mit Schreibrecht; Sticky-Verzeichnisse schützen fremde Einträge", () => {
    expect(canModify(stat(0, 0, 0o644), groupPeer)).toBe(false);
    expect(canModify(stat(groupPeer.uid, 0, 0o400), groupPeer)).toBe(true);
    expect(canModify(stat(0, groupPeer.gid, 0o664), groupPeer)).toBe(true);
    expect(canModify(stat(0, 0, 0o1777), groupPeer)).toBe(true);
    expect(canReplaceEntries(stat(0, 0, 0o1777), groupPeer)).toBe(false);
    expect(canReplaceEntries(stat(0, 0, 0o777), groupPeer)).toBe(true);
  });
});

describe("Pfade und Bäume", () => {
  it("traversedDirectories folgt Symlinks wie der Kernel (current → releases/<sha>)", () => {
    const base = scratch();
    mkdirSync(join(base, "releases", "r1", "web"), { recursive: true });
    symlinkSync(join("releases", "r1"), join(base, "current"));
    const dirsOnPath = traversedDirectories(join(base, "current", "web", "server.js"));
    expect(dirsOnPath).toContain("/");
    expect(dirsOnPath).toContain(base);
    expect(dirsOnPath).toContain(join(base, "releases"));
    expect(dirsOnPath).toContain(join(base, "releases", "r1", "web"));
    expect(dirsOnPath).not.toContain(join(base, "current"));
  });

  it("pathProblems: nicht durchsuchbare und veränderbare Verzeichnisse, fehlende Rechte am Ziel", () => {
    const base = scratch();
    const secret = join(base, "secret");
    mkdirSync(secret, { mode: 0o700 });
    writeFileSync(join(secret, "file"), "x", { mode: 0o644 });
    expect(pathProblems({ label: "file", path: join(secret, "file"), want: R }, groupPeer, "svc")).toEqual([
      expect.stringMatching(/secret \(0700 .*\) ist für svc nicht durchsuchbar/),
    ]);
    chmodSync(secret, 0o750);
    expect(pathProblems({ label: "file", path: join(secret, "file"), want: R }, groupPeer, "svc")).toEqual([]);
    chmodSync(secret, 0o770);
    expect(
      pathProblems({ label: "file", path: join(secret, "file"), want: R, forbidModify: true }, groupPeer, "svc"),
    ).toEqual([expect.stringMatching(/secret \(0770 .*\) ist für svc veränderbar/)]);
    chmodSync(join(secret, "file"), 0o600);
    expect(pathProblems({ label: "file", path: join(secret, "file"), want: R | X }, groupPeer, "svc")).toEqual([
      expect.stringMatching(/^file \(0600 .*\) ist für svc nicht lesbar und nicht ausführbar$/),
    ]);
    expect(pathProblems({ label: "nope", path: join(base, "nope"), want: R }, groupPeer, "svc")).toEqual([
      "nope fehlt oder ist nicht auflösbar",
    ]);
  });

  it("pathProblems mit hidePaths nennt keine Pfade (Werte aus MONGODB_URI)", () => {
    const base = scratch();
    const hidden = join(base, "geheimer-ort");
    mkdirSync(hidden, { mode: 0o700 });
    writeFileSync(join(hidden, "ca.pem"), "x", { mode: 0o644 });
    const problems = pathProblems(
      { label: "tlsCAFile aus MONGODB_URI", path: join(hidden, "ca.pem"), want: R, hidePaths: true },
      groupPeer,
      "svc",
    );
    expect(problems).toEqual([
      "ein Verzeichnis auf dem Weg zu tlsCAFile aus MONGODB_URI ist für svc nicht durchsuchbar",
    ]);
    expect(problems.join()).not.toContain("geheimer-ort");
  });

  it("treeProblems: unlesbar, veränderbar, ausgeschlossene Pfade und Symlinks", () => {
    const base = scratch();
    const tree = join(base, "release");
    mkdirSync(join(tree, "lib", "cache"), { recursive: true });
    // chmod statt mode beim Schreiben: die umask würde Gruppen-Schreibrechte entfernen.
    const file = (path: string, mode: number) => {
      writeFileSync(path, "x");
      chmodSync(path, mode);
    };
    file(join(tree, "ok.js"), 0o644);
    file(join(tree, "lib", "geheim.json"), 0o600);
    file(join(tree, "lib", "offen.js"), 0o664);
    file(join(tree, "lib", "tool"), 0o744);
    file(join(tree, "lib", "cache", "egal"), 0o666);
    symlinkSync("/etc/hostname", join(tree, "link"));
    const result = treeProblems(tree, groupPeer, "svc", { exclude: [join(tree, "lib", "cache")] });
    expect(result.problems).toHaveLength(3);
    expect(result.problems.join("\n")).toContain("release/lib/geheim.json (0600");
    expect(result.problems.join("\n")).toContain("release/lib/offen.js (0664");
    expect(result.problems.join("\n")).toMatch(/release\/lib\/tool \(0744 .*\) ist für svc nicht ausführbar/);
    expect(result.problems.join("\n")).not.toContain("egal");
    expect(result.entries).toBe(7);
  });
});

describe("Änderungen", () => {
  it("removeTree löscht nur den Baum – Symlinks darin werden nicht verfolgt", async () => {
    const base = scratch();
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "bleibt");
    const tree = join(base, "tree");
    mkdirSync(join(tree, "sub"), { recursive: true });
    writeFileSync(join(tree, "sub", "file"), "x");
    symlinkSync(outside, join(tree, "sub", "link"));
    await removeTree(tree);
    expect(existsSync(tree)).toBe(false);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  it("ensureWebCache: anlegen (0700), behalten, Fremdes (Symlink) beiseitelegen und ersetzen", async () => {
    const layout = fixture();
    const cache = webCacheDir(layout, SHA);
    expect(await ensureWebCache(layout, SHA, me)).toBe("created");
    expect(statSync(cache).mode & 0o7777).toBe(CACHE_DIR_MODE);
    chmodSync(cache, 0o755);
    expect(await ensureWebCache(layout, SHA, me)).toBe("kept");
    expect(statSync(cache).mode & 0o7777).toBe(CACHE_DIR_MODE);

    const outside = join(layout.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "bleibt");
    rmSync(cache, { recursive: true });
    symlinkSync(outside, cache);
    const removed: string[] = [];
    expect(
      await ensureWebCache(layout, SHA, me, async (path) => {
        removed.push(path);
        await removeTree(path);
      }),
    ).toBe("replaced");
    expect(lstatSync(cache).isDirectory()).toBe(true);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/\.next\/\.cache-stale-\d+-\d+$/);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(readdirSync(join(cache, "..")).some((name) => name.includes("cache-stale"))).toBe(false);
  });

  it.skipIf(!isRoot)(
    "ensureWebCache (root): Cache gehört dem Dienstbenutzer, ein root-Cache wird ersetzt",
    async () => {
      const layout = fixture();
      const cache = webCacheDir(layout, SHA);
      mkdirSync(join(cache, "images"), { recursive: true });
      expect(await ensureWebCache(layout, SHA, { uid: 65534, gid: 65534 })).toBe("replaced");
      expect(statSync(cache)).toMatchObject({ uid: 65534, gid: 65534 });
      expect(readdirSync(cache)).toEqual([]);
      expect(await ensureWebCache(layout, SHA, { uid: 65534, gid: 65534 })).toBe("kept");
    },
  );

  it("deployChain: Produktion nur .deploy, Testmodus .deploy und .deploy/test", () => {
    expect(deployChain(layoutFor("/srv/app"))).toEqual(["/srv/app/.deploy"]);
    expect(deployChain(layoutFor("/srv/app", "test"))).toEqual(["/srv/app/.deploy", "/srv/app/.deploy/test"]);
  });

  it("envAccess: mit Dienstbenutzer 0750/0640 und dessen Gruppe, ohne 0700/0600 – Besitzer ist der Deploy", () => {
    expect(envAccess(service(4242, 4343))).toEqual({ uid: me.uid, gid: 4343, dirMode: 0o750, fileMode: 0o640 });
    expect(envAccess(ROOT_FALLBACK)).toEqual({ uid: me.uid, gid: me.gid, dirMode: 0o700, fileMode: 0o600 });
  });

  it("prepareAccess ohne Dienstbenutzer: Env 0700/0600 wie bisher, Releases nur root, .deploy bleibt 0700", async () => {
    const layout = fixture();
    mkdirSync(layout.envDir, { mode: 0o750 });
    writeFileSync(envFile(layout, "web"), "RELEASE=x\n", { mode: 0o640 });
    const lines = await prepareAccess({ layout, identity: ROOT_FALLBACK, releases: [SHA] });
    expect(lines.join()).toContain("kein Dienstbenutzer");
    expect(statSync(layout.envDir).mode & 0o777).toBe(0o700);
    expect(statSync(envFile(layout, "web")).mode & 0o777).toBe(0o600);
    expect(statSync(layout.releasesDir).mode & 0o777).toBe(0o700);
    expect(statSync(layout.deployDir).mode & 0o777).toBe(0o700);
    expect(statSync(webCacheDir(layout, SHA)).uid).toBe(me.uid);
  });

  it.skipIf(!isRoot)("prepareAccess (root) für nobody im Testlayout: Rechte gesetzt, Prüfung bestanden", async () => {
    const layout = fixture("test");
    mkdirSync(layout.envDir, { mode: 0o700 });
    writeFileSync(envFile(layout, "web"), "RELEASE=x\n", { mode: 0o600 });
    const nobody = service(65534, 65534, "nobody");
    const ecosystem = join(layout.root, "ecosystem.config.js");
    writeFileSync(ecosystem, "module.exports = {};\n", { mode: 0o644 });
    const rootCode = [{ label: "ecosystem.config.js", path: ecosystem }];
    const lines = await prepareAccess({ layout, identity: nobody, releases: [SHA], rootCode });
    expect(lines.join("\n")).toMatch(/für nobody lesbar, nicht veränderbar/);
    for (const dir of deployChain(layout)) expect(statSync(dir).mode & 0o7777).toBe(0o711);
    expect(statSync(layout.envDir)).toMatchObject({ uid: 0, gid: 65534 });
    expect(statSync(layout.envDir).mode & 0o777).toBe(0o750);
    expect(statSync(envFile(layout, "web")).mode & 0o777).toBe(0o640);
    expect(statSync(webCacheDir(layout, SHA))).toMatchObject({ uid: 65534, gid: 65534 });
    // Releases (Schlüssel im Next-Build) nur für die Gruppe – ein drittes Konto kommt nicht hinein.
    expect(statSync(layout.releasesDir)).toMatchObject({ uid: 0, gid: 65534 });
    expect(statSync(layout.releasesDir).mode & 0o777).toBe(0o750);
    const server = join(releaseDir(layout, SHA), "web", "apps", "web", "server.js");
    expect(pathProblems({ label: "server.js", path: server, want: R }, { uid: 33, gid: 33 }, "www-data")).toEqual([
      expect.stringMatching(/releases \(0750 root:nogroup\) ist für www-data nicht durchsuchbar/),
    ]);

    // Vom pm2-CLI als root geladener Code, der für den Dienstbenutzer veränderbar wäre, bricht ab.
    chmodSync(ecosystem, 0o666);
    await expect(prepareAccess({ layout, identity: nobody, releases: [SHA], rootCode })).rejects.toThrow(
      /ecosystem\.config\.js \(0666 root:root\) ist für nobody veränderbar/,
    );
    chmodSync(ecosystem, 0o644);

    // Eine unlesbare Release-Datei bricht ab, bevor etwas umgeschaltet wird.
    chmodSync(server, 0o600);
    await expect(prepareAccess({ layout, identity: nobody, releases: [SHA] })).rejects.toThrow(
      /server\.js \(0600 root:root\) ist für nobody nicht lesbar/,
    );
  });

  it.skipIf(isRoot)(
    "prepareAccess mit Dienstbenutzer ohne root: chown auf fremde uid scheitert vor der Aktivierung",
    async () => {
      const layout = fixture();
      await expect(
        prepareAccess({ layout, identity: service(groupPeer.uid, groupPeer.gid), releases: [SHA] }),
      ).rejects.toThrow();
    },
  );
});

describe("Prozess-Identität (Smoke-Test)", () => {
  const status = (uid: string, gid: string, groups = "") =>
    `Name:\tnode\nUmask:\t0022\nState:\tS (sleeping)\nUid:\t${uid}\nGid:\t${gid}\nFDSize:\t64\nGroups:\t${groups}\n`;

  it("parseProcStatus liest Uid/Gid (real, effektiv, gespeichert, fs) und Zusatzgruppen", () => {
    expect(parseProcStatus(status("997\t997\t997\t997", "996\t996\t996\t996", "996 "))).toEqual({
      uids: [997, 997, 997, 997],
      gids: [996, 996, 996, 996],
      groups: [996],
    });
    expect(() => parseProcStatus("Name:\tnode\n")).toThrow(/nicht auswertbar/);
    expect(() => parseProcStatus(status("1\t1\t1", "1\t1\t1\t1"))).toThrow(/nicht auswertbar/);
    const self = readProcStatus(process.pid);
    expect(self.uids[1]).toBe(me.uid);
  });

  it("identityMismatch: jede abweichende uid/gid, mit Dienstbenutzer auch fremde Zusatzgruppen", () => {
    const expected = { uid: 997, gid: 996 };
    expect(identityMismatch(parseProcStatus(status("997 997 997 997", "996 996 996 996")), expected, true)).toBeNull();
    expect(identityMismatch(parseProcStatus(status("0 0 0 0", "0 0 0 0")), expected, true)).toBe(
      "uid 0/0/0/0 statt 997",
    );
    expect(identityMismatch(parseProcStatus(status("997 0 997 997", "996 996 996 996")), expected, true)).toMatch(
      /^uid 997\/0/,
    );
    expect(identityMismatch(parseProcStatus(status("997 997 997 997", "996 996 996 0")), expected, true)).toMatch(
      /^gid /,
    );
    const withRootGroup = parseProcStatus(status("997 997 997 997", "996 996 996 996", "0 996"));
    expect(identityMismatch(withRootGroup, expected, true)).toMatch(/Zusatzgruppen 0,996/);
    expect(identityMismatch(withRootGroup, expected, false)).toBeNull();
  });
});

describe("mongoUriFiles", () => {
  it("findet Datei-Parameter (auch kodiert), ignoriert relative Pfade und nennt nur Parameternamen", () => {
    const uri =
      "mongodb://u:p@db.example.com:27017/?tls=true&tlsCAFile=%2Fetc%2Fssl%2Fca.pem&TLSCertificateKeyFile=/srv/key.pem" +
      "&tlsCRLFile=relativ.pem";
    expect(mongoUriFiles(uri)).toEqual([
      { label: "tlsCAFile aus MONGODB_URI", path: "/etc/ssl/ca.pem" },
      { label: "tlsCertificateKeyFile aus MONGODB_URI", path: "/srv/key.pem" },
    ]);
    expect(mongoUriFiles("mongodb+srv://u:p@cluster.example.com/")).toEqual([]);
  });
});
