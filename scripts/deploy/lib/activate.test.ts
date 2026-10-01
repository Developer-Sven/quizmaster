import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceIdentity } from "../service-user.cjs";
import { ActivationError, activate, currentRelease, type DeployContext, type SmokeTest } from "./activate.ts";
import { type AppKey, envFile, type Layout, layoutFor, releaseDir } from "./layout.ts";
import type { Pm2App, Pm2Client } from "./pm2.ts";
import type { SourceContext } from "./source-env.ts";

const ROOT_FALLBACK: ServiceIdentity = { kind: "root", user: "quizmaster", uid: 0, gid: 0, reason: "Test" };
/** Dienstbenutzer für Tests ohne root: fremde uid, eigene Gruppe (chown auf die eigene Gruppe ist erlaubt). */
const SERVICE: ServiceIdentity = {
  kind: "service",
  user: "svc",
  uid: (process.getuid?.() ?? 0) + 1,
  gid: process.getgid?.() ?? 0,
  group: "svc",
  home: "/nonexistent",
  shell: "/usr/sbin/nologin",
  sharedWith: [],
};

// Aktivierung und Rückweg (ADR-025) ohne echten pm2-Daemon: pm2 als Prozesstabelle im Speicher, Smoke-Test
// injiziert. Geprüft werden Reihenfolge, Symlink, Env-Dateien und der Rückweg bei jedem Fehlerbild.
const A = "a".repeat(40);
const B = "b".repeat(40);

let root: string;
let layout: Layout;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qm-activate-test-"));
  layout = layoutFor(root);
  for (const console_ of ["log", "warn", "error"] as const) vi.spyOn(console, console_).mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function release(sha: string, watchdog = true): void {
  const dir = releaseDir(layout, sha);
  mkdirSync(join(dir, "web", "apps", "web"), { recursive: true });
  mkdirSync(join(dir, "realtime", "dist"), { recursive: true });
  writeFileSync(join(dir, "web", "apps", "web", "server.js"), "");
  writeFileSync(join(dir, "realtime", "dist", "index.mjs"), "");
  if (watchdog) writeFileSync(join(dir, "realtime", "dist", "watchdog.mjs"), "");
  writeFileSync(
    join(dir, "release.json"),
    JSON.stringify({ sha, builtAt: "2026-10-01T00:00:00Z", subject: "t", hasWatchdog: watchdog, webBuildId: null }),
  );
}

/** pm2 als Prozesstabelle; `calls` protokolliert Starts und Löschungen in Reihenfolge (mit aktivem Release). */
function fakePm2() {
  const procs = new Map<string, Pm2App>();
  const calls: string[] = [];
  let pid = 1000;
  const client: Pm2Client = {
    async list(names) {
      return [...procs.values()].filter((proc) => names.includes(proc.name)).map((proc) => ({ ...proc }));
    },
    async startOrReload(name) {
      calls.push(`start ${name}@${currentRelease(layout)?.slice(0, 1)}`);
      const previous = procs.get(name);
      pid += 1;
      procs.set(name, {
        name,
        pid,
        status: "online",
        restarts: previous ? previous.restarts + 1 : 0,
        startedAt: Date.now(),
        memoryBytes: 1,
        cpuPercent: 0,
      });
      return [];
    },
    async remove(name) {
      calls.push(`delete ${name}`);
      procs.delete(name);
      return [];
    },
    async save() {
      return [];
    },
  };
  return { client, procs, calls };
}

function context(pm2: Pm2Client, smokeTest: SmokeTest, identity: ServiceIdentity = ROOT_FALLBACK): DeployContext {
  return {
    layout,
    pm2,
    pm2Home: join(root, "pm2"),
    source: { mode: "test", path: "", label: "test.env", resolved: {} } as unknown as SourceContext,
    identity,
    backupRoot: join(root, "backups"),
    simulateFailure: null,
    smokeTest,
    settleMs: 0,
  };
}

const envFor = (app: AppKey, sha: string) => `# ${app}\nRELEASE=${sha}\n`;
const releaseIn = (app: AppKey) => /RELEASE=(\w)/.exec(readFileSync(envFile(layout, app), "utf8"))?.[1];
const failing =
  (app: AppKey, ...shas: string[]): SmokeTest =>
  async (candidate, sha) => {
    if (candidate === app && shas.includes(sha)) throw new Error(`Smoke ${candidate} schlägt fehl`);
  };

describe("activate", () => {
  it("startet web → realtime → watchdog aus dem neuen Release und hängt current um", async () => {
    release(A);
    release(B);
    const { client, calls } = fakePm2();
    const smoked: string[] = [];
    await activate(
      context(client, async (app, sha) => {
        smoked.push(`${app}@${sha.slice(0, 1)}`);
      }),
      { target: B, fallback: A, apps: ["web", "realtime", "watchdog"], envFor },
    );
    expect(calls).toEqual(["start quizmaster-web@b", "start quizmaster-realtime@b", "start quizmaster-watchdog@b"]);
    expect(smoked).toEqual(["web@b", "realtime@b", "watchdog@b"]);
    expect(readlinkSync(layout.current)).toBe(join("releases", B));
    expect(["web", "realtime", "watchdog"].map((app) => releaseIn(app as AppKey))).toEqual(["b", "b", "b"]);
  });

  it("Smoke-Fehler bei realtime → Rückweg: current, Env und genau web+realtime zurück auf das alte Release", async () => {
    release(A);
    release(B);
    const { client, calls, procs } = fakePm2();
    const error = await activate(context(client, failing("realtime", B)), {
      target: B,
      fallback: A,
      apps: ["web", "realtime", "watchdog"],
      envFor,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActivationError);
    expect((error as ActivationError).reverted).toBe(true);
    expect(calls).toEqual([
      "start quizmaster-web@b",
      "start quizmaster-realtime@b",
      "start quizmaster-web@a",
      "start quizmaster-realtime@a",
    ]);
    expect(currentRelease(layout)).toBe(A);
    expect([releaseIn("web"), releaseIn("realtime")]).toEqual(["a", "a"]);
    expect(procs.has("quizmaster-watchdog")).toBe(false);
  });

  it("Erst-Deploy scheitert → gestartete Apps werden entfernt, current verschwindet", async () => {
    release(B);
    const { client, calls, procs } = fakePm2();
    const error = await activate(context(client, failing("web", B)), {
      target: B,
      fallback: null,
      apps: ["web", "realtime", "watchdog"],
      envFor,
    }).catch((caught: unknown) => caught);
    expect((error as ActivationError).reverted).toBe(true);
    expect(calls).toEqual(["start quizmaster-web@b", "delete quizmaster-web"]);
    expect(procs.size).toBe(0);
    expect(currentRelease(layout)).toBeNull();
  });

  it("Release ohne Watchdog: laufender Watchdog wird entfernt, nicht mit fremdem Release gestartet", async () => {
    release(A);
    release(B, false);
    const { client, calls, procs } = fakePm2();
    await client.startOrReload("quizmaster-watchdog");
    calls.length = 0;
    await activate(
      context(client, async () => {}),
      { target: B, fallback: A, apps: ["web", "realtime", "watchdog"], envFor },
    );
    expect(calls).toEqual(["start quizmaster-web@b", "start quizmaster-realtime@b", "delete quizmaster-watchdog"]);
    expect(procs.has("quizmaster-watchdog")).toBe(false);
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toContain("enthält kein dist/watchdog.mjs");
  });

  it("scheitert auch der Rückweg, meldet ActivationError reverted=false (Exit 3 im Werkzeug)", async () => {
    release(A);
    release(B);
    const { client } = fakePm2();
    const error = await activate(context(client, failing("realtime", A, B)), {
      target: B,
      fallback: A,
      apps: ["web", "realtime"],
      envFor,
    }).catch((caught: unknown) => caught);
    expect((error as ActivationError).reverted).toBe(false);
    expect((error as Error).message).toContain("Rückweg unvollständig");
    expect(currentRelease(layout)).toBe(A);
  });

  it("ohne Dienstbenutzer: Env-Dateien 0600, Verzeichnis 0700 (Stand vor der Umstellung)", async () => {
    release(A);
    const { client } = fakePm2();
    await activate(
      context(client, async () => {}),
      { target: A, fallback: null, apps: ["web", "realtime"], envFor },
    );
    for (const app of ["web", "realtime"] as const) expect(statSync(envFile(layout, app)).mode & 0o777).toBe(0o600);
    expect(statSync(layout.envDir).mode & 0o777).toBe(0o700);
  });

  it("mit Dienstbenutzer: Env-Dateien 0640 mit dessen Gruppe, Verzeichnis 0750 – auch beim Wechsel von root", async () => {
    release(A);
    release(B);
    const { client } = fakePm2();
    await activate(
      context(client, async () => {}),
      { target: A, fallback: null, apps: ["web", "realtime"], envFor },
    );
    await activate(
      context(client, async () => {}, SERVICE),
      { target: B, fallback: A, apps: ["web", "realtime"], envFor },
    );
    for (const app of ["web", "realtime"] as const) {
      const stat = statSync(envFile(layout, app));
      expect(stat.mode & 0o777).toBe(0o640);
      expect(stat.gid).toBe(SERVICE.gid);
      expect(stat.uid).toBe(process.getuid?.() ?? 0);
      expect(releaseIn(app)).toBe("b");
    }
    expect(statSync(layout.envDir).mode & 0o777).toBe(0o750);
    expect(statSync(layout.envDir).gid).toBe(SERVICE.gid);
  });

  it("App stürzt nach dem Smoke-Test ab (pm2 startet neu) → Aktivierung gilt als gescheitert", async () => {
    release(A);
    release(B);
    const { client, procs } = fakePm2();
    let crashed = false;
    const error = await activate(
      context(client, async (app, sha) => {
        // Nach dem Smoke-Test von realtime@b startet pm2 web neu (neue PID) – checkStable muss das erkennen.
        if (app === "realtime" && sha === B && !crashed) {
          crashed = true;
          const web = procs.get("quizmaster-web");
          if (web) procs.set(web.name, { ...web, pid: web.pid + 100, restarts: web.restarts + 1 });
        }
      }),
      { target: B, fallback: A, apps: ["web", "realtime"], envFor },
    ).catch((caught: unknown) => caught);
    expect((error as ActivationError).reverted).toBe(true);
    expect((error as Error).message).toContain("APP_UNSTABLE");
    expect(currentRelease(layout)).toBe(A);
  });
});
