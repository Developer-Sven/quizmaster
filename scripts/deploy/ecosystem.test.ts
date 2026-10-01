import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { APPS } from "./lib/layout.ts";

interface PmApp {
  name: string;
  cwd: string;
  script: string;
  interpreter: string;
  interpreter_args: string[];
  exec_mode: string;
  instances: number;
  uid: number;
  gid: number;
  filter_env: unknown;
  env: Record<string, string>;
  max_memory_restart: string;
  wait_ready?: boolean;
  listen_timeout?: number;
  kill_timeout?: number;
  exp_backoff_restart_delay?: number;
  min_uptime?: number;
  merge_logs?: boolean;
}

const root = resolve(import.meta.dirname, "../..");
const ecosystem = join(root, "ecosystem.config.js");
const deploy = join(root, ".deploy");
const scratch = mkdtempSync(join(tmpdir(), "qm-ecosystem-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// pm2 lädt ecosystem.config.js in seinem CLI-Prozess; hier ein eigener Node-Prozess je Fall, in dem eine
// Preload-Datei /etc/passwd und /etc/group durch synthetische Inhalte ersetzt – der Test hängt so nicht davon ab,
// ob es den Benutzer quizmaster auf diesem Rechner gibt.
const preload = join(scratch, "fake-etc.cjs");
writeFileSync(
  preload,
  `const fs = require("node:fs");
const original = fs.readFileSync;
const fake = { "/etc/passwd": process.env.FAKE_PASSWD, "/etc/group": process.env.FAKE_GROUP };
fs.readFileSync = function (file, ...rest) {
  if (typeof file === "string" && Object.hasOwn(fake, file)) {
    if (fake[file] === undefined) throw Object.assign(new Error("ENOENT: " + file), { code: "ENOENT" });
    return fake[file];
  }
  return original.call(this, file, ...rest);
};
`,
);

const BASE_PASSWD = [
  "root:x:0:0:root:/root:/bin/bash",
  "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
  "_apt:x:100:65534::/nonexistent:/usr/sbin/nologin",
].join("\n");
const WITH_SERVICE = `${BASE_PASSWD}\nquizmaster:x:997:997:quizmaster:/nonexistent:/usr/sbin/nologin`;
const GROUP = "root:x:0:\nnogroup:x:65534:\nquizmaster:x:997:";

interface LoadOptions {
  passwd?: string | undefined;
  group?: string | undefined;
  env?: Record<string, string>;
}

function load(options: LoadOptions = {}): { apps: PmApp[] } {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", ...options.env };
  const passwd = "passwd" in options ? options.passwd : BASE_PASSWD;
  const group = "group" in options ? options.group : GROUP;
  if (passwd !== undefined) env.FAKE_PASSWD = passwd;
  if (group !== undefined) env.FAKE_GROUP = group;
  const out = execFileSync(
    process.execPath,
    ["--require", preload, "-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(ecosystem)})))`],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out) as { apps: PmApp[] };
}

/** Fehlermeldung beim Laden (pm2 bricht dann vor jedem Start ab). */
function loadError(options: LoadOptions): string {
  try {
    load(options);
  } catch (error) {
    return String((error as { stderr?: unknown }).stderr ?? error);
  }
  throw new Error("ecosystem.config.js hätte abbrechen müssen");
}

const rootConfig = load();
const byName = new Map(rootConfig.apps.map((app) => [app.name, app]));

describe("ecosystem.config.js (ADR-024)", () => {
  it("definiert genau die drei Apps mit den Namen, die der Deploy erwartet", () => {
    expect(rootConfig.apps.map((app) => app.name)).toEqual(Object.values(APPS).map((app) => app.name));
  });

  it("alle Apps: Fork, 1 Instanz, Node 24 aus .deploy/runtime, Env nur per --env-file", () => {
    for (const app of rootConfig.apps) {
      expect(app.exec_mode).toBe("fork");
      expect(app.instances).toBe(1);
      expect(app.interpreter).toBe(join(deploy, "runtime", "node", "bin", "node"));
      const key = app.name.replace("quizmaster-", "");
      expect(app.interpreter_args[0]).toBe(`--env-file=${join(deploy, "env", `${key}.env`)}`);
      // Shell-Umgebung des Aufrufers darf nicht durchsickern (filter_env: true ist in pm2 6 wirkungslos).
      expect(app.filter_env).toEqual([""]);
      expect(Object.keys(app.env)).toEqual(["PATH"]);
      expect(app.exp_backoff_restart_delay).toBeGreaterThan(0);
      expect(app.min_uptime).toBeGreaterThan(0);
      expect(app.merge_logs).toBe(true);
    }
  });

  it("Pfade zeigen über den current-Symlink in das Release", () => {
    for (const spec of Object.values(APPS)) {
      const app = byName.get(spec.name);
      expect(app?.cwd).toBe(join(deploy, "current", spec.cwd));
      expect(join(app?.cwd ?? "", app?.script ?? "")).toBe(join(deploy, "current", spec.entry));
    }
  });

  it("Speichergrenzen und Realtime-Lebenszyklus wie spezifiziert", () => {
    expect(byName.get("quizmaster-web")?.max_memory_restart).toBe("768M");
    const realtime = byName.get("quizmaster-realtime");
    expect(realtime).toMatchObject({
      max_memory_restart: "1536M",
      wait_ready: true,
      listen_timeout: 20_000,
      kill_timeout: 15_000,
    });
    expect(byName.get("quizmaster-watchdog")?.max_memory_restart).toBe("128M");
  });

  it("QM_DEPLOY_DIR lenkt nur Tests nach .deploy/test um – jeder andere Pfad bricht ab", () => {
    const test = load({ env: { QM_DEPLOY_DIR: join(deploy, "test") } });
    expect(test.apps[0]?.cwd).toBe(join(deploy, "test", "current", "web", "apps", "web"));
    expect(loadError({ env: { QM_DEPLOY_DIR: join(root, "anderswo") } })).toMatch(/nur als/);
    expect(loadError({ env: { QM_DEPLOY_DIR: deploy } })).toMatch(/nur als/);
  });

  it("enthält keine Secrets, Ports oder Domains", () => {
    const text = JSON.stringify(rootConfig);
    for (const needle of ["SECRET", "MONGODB", "TOKEN", "7400", "7401", "https://"]) expect(text).not.toContain(needle);
  });
});

describe("ecosystem.config.js – Benutzer der Apps (docs/12 „Nicht-Root-User“)", () => {
  it("ohne Benutzer quizmaster: uid/gid 0 (= Benutzer des Daemons, setzt alte uids zurück), kein HOME", () => {
    for (const app of rootConfig.apps) {
      expect(app).toMatchObject({ uid: 0, gid: 0 });
      expect(app.env).not.toHaveProperty("HOME");
    }
  });

  it("mit Benutzer quizmaster: alle drei Apps mit dessen uid/gid (numerisch) und HOME aus /etc/passwd", () => {
    const config = load({ passwd: WITH_SERVICE });
    expect(config.apps).toHaveLength(3);
    for (const app of config.apps) {
      expect(app).toMatchObject({ uid: 997, gid: 997 });
      expect(app.env).toEqual({
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/nonexistent",
      });
    }
  });

  it("fail closed: uid 0, nicht exklusive Gruppe oder unlesbare Kataloge brechen ab statt still root", () => {
    expect(loadError({ passwd: `${BASE_PASSWD}\nquizmaster:x:0:997::/:/usr/sbin/nologin` })).toMatch(/0 wäre root/);
    expect(
      loadError({ passwd: WITH_SERVICE, group: GROUP.replace("quizmaster:x:997:", "quizmaster:x:997:www-data") }),
    ).toMatch(/nicht exklusiv/);
    expect(loadError({ passwd: undefined })).toMatch(/\/etc\/passwd nicht lesbar/);
    expect(loadError({ passwd: WITH_SERVICE, group: undefined })).toMatch(/\/etc\/group nicht lesbar/);
  });

  it("QM_SERVICE_USER (Test-Umleitung) nur mit .deploy/test – dort auch mit geteilter Gruppe, aber nie ohne Benutzer", () => {
    expect(loadError({ env: { QM_SERVICE_USER: "nobody" } })).toMatch(/nur für Tests/);
    const test = load({ env: { QM_DEPLOY_DIR: join(deploy, "test"), QM_SERVICE_USER: "nobody" } });
    for (const app of test.apps) expect(app).toMatchObject({ uid: 65534, gid: 65534 });
    expect(loadError({ env: { QM_DEPLOY_DIR: join(deploy, "test"), QM_SERVICE_USER: "fehlt" } })).toMatch(
      /existiert nicht/,
    );
    expect(loadError({ env: { QM_DEPLOY_DIR: join(deploy, "test"), QM_SERVICE_USER: "root" } })).toMatch(/0 wäre root/);
  });
});
