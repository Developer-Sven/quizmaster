import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APPS } from "./lib/layout.ts";

interface PmApp {
  name: string;
  cwd: string;
  script: string;
  interpreter: string;
  interpreter_args: string[];
  exec_mode: string;
  instances: number;
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
const require = createRequire(import.meta.url);
const config = require(join(root, "ecosystem.config.js")) as { apps: PmApp[] };
const byName = new Map(config.apps.map((app) => [app.name, app]));
const deploy = join(root, ".deploy");

describe("ecosystem.config.js (ADR-024)", () => {
  it("definiert genau die drei Apps mit den Namen, die der Deploy erwartet", () => {
    expect(config.apps.map((app) => app.name)).toEqual(Object.values(APPS).map((app) => app.name));
  });

  it("alle Apps: Fork, 1 Instanz, Node 24 aus .deploy/runtime, Env nur per --env-file", () => {
    for (const app of config.apps) {
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
    const load = (dir: string) =>
      execFileSync(
        process.execPath,
        ["-e", `console.log(require(${JSON.stringify(join(root, "ecosystem.config.js"))}).apps[0].cwd)`],
        { env: { ...process.env, QM_DEPLOY_DIR: dir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    expect(load(join(deploy, "test"))).toBe(join(deploy, "test", "current", "web", "apps", "web"));
    expect(() => load(join(root, "anderswo"))).toThrow(/nur als/);
    expect(() => load(deploy)).toThrow(/nur als/);
  });

  it("enthält keine Secrets, Ports oder Domains", () => {
    const text = JSON.stringify(config);
    for (const needle of ["SECRET", "MONGODB", "TOKEN", "7400", "7401", "https://"]) expect(text).not.toContain(needle);
  });
});
