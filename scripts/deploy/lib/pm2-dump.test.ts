import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistProcessList } from "./activate.ts";
import { APP_NAMES } from "./layout.ts";
import type { Pm2Client } from "./pm2.ts";
import { mergeDump, pruneDumpBackups } from "./pm2-dump.ts";

type Entry = { name: string; status: string; env?: Record<string, string>; pm_exec_path?: string };

const entry = (name: string, status: string, extra: Partial<Entry> = {}): Entry => ({
  name,
  status,
  pm_exec_path: `/srv/${name}/index.js`,
  ...extra,
});
const dumpText = (entries: readonly Entry[]) => JSON.stringify(entries, null, 2);
const names = (text: string) => (JSON.parse(text) as Entry[]).map((item) => `${item.name}:${item.status}`);

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dump-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Wie `pm2 save` (pm2 6, lib/API/Startup.js dump): alte Datei → .bak, dann den GESAMTEN Daemon-Zustand schreiben. */
function fakePm2(home: string, daemon: readonly Entry[]): Pm2Client & { saves: number } {
  const client = {
    saves: 0,
    list: async () => [],
    startOrReload: async () => [],
    remove: async () => [],
    async save() {
      client.saves += 1;
      const dump = join(home, "dump.pm2");
      if (existsSync(dump)) writeFileSync(join(home, "dump.pm2.bak"), readFileSync(dump));
      writeFileSync(dump, dumpText(daemon), { mode: 0o644 });
      return ["[PM2] Saving current process list...", `[PM2] Successfully saved in ${dump}`];
    },
  };
  return client;
}

describe("persistProcessList – pm2 save auf dem gemeinsamen Haupt-Daemon", () => {
  it("ändert die gespeicherte Prozessliste fremder Apps nie, übernimmt nur quizmaster-*", async () => {
    const home = tempDir();
    const backupRoot = join(tempDir(), "backups");
    // Gespeichert (Boot-Zustand): fremde-a läuft, wolffv-x ist absichtlich gestoppt, altes quizmaster-web.
    const saved = [
      entry("fremde-a", "online", { env: { STRIPE_SECRET: "sk_live_geheim" } }),
      entry("wolffv-x", "stopped"),
      entry("quizmaster-web", "online", { pm_exec_path: "/alt/server.js" }),
    ];
    writeFileSync(join(home, "dump.pm2"), dumpText(saved), { mode: 0o644 });
    // Jetzt im Daemon: fremde-a gerade manuell gestoppt, wolffv-x gelöscht, probe-app nur probeweise gestartet.
    const daemon = [
      entry("fremde-a", "stopped", { env: { STRIPE_SECRET: "sk_live_geheim" } }),
      entry("probe-app", "online"),
      entry("quizmaster-web", "online", { pm_exec_path: "/neu/server.js" }),
      entry("quizmaster-realtime", "online"),
    ];
    const pm2 = fakePm2(home, daemon);

    const result = await persistProcessList({ pm2, pm2Home: home, backupRoot });

    expect(pm2.saves).toBe(1);
    const after = readFileSync(join(home, "dump.pm2"), "utf8");
    expect(names(after)).toEqual([
      "fremde-a:online",
      "wolffv-x:stopped",
      "quizmaster-web:online",
      "quizmaster-realtime:online",
    ]);
    expect((JSON.parse(after) as Entry[]).find((item) => item.name === "quizmaster-web")?.pm_exec_path).toBe(
      "/neu/server.js",
    );
    // Rechte wie von pm2 geschrieben; Sicherung des vorherigen Stands (600).
    expect(statSync(join(home, "dump.pm2")).mode & 0o777).toBe(0o644);
    expect(result.backup).not.toBeNull();
    expect(readFileSync(result.backup ?? "", "utf8")).toBe(dumpText(saved));
    expect(statSync(result.backup ?? "").mode & 0o777).toBe(0o600);
    // Bericht: nur Namen und Status, nie Werte.
    expect(result.merge).toMatchObject({ merged: true, keptForeign: 2, ours: 2 });
    const drift = result.merge?.merged ? result.merge.drift.join("\n") : "";
    expect(drift).toContain("fremde-a");
    expect(drift).toContain("probe-app");
    expect(drift).toContain("wolffv-x");
    expect(drift).not.toContain("geheim");
  });

  it("ohne vorherige Liste wird nur quizmaster-* gespeichert (fremde Apps waren nie persistiert)", async () => {
    const home = tempDir();
    const pm2 = fakePm2(home, [entry("fremde-a", "online"), entry("quizmaster-web", "online")]);
    const result = await persistProcessList({ pm2, pm2Home: home, backupRoot: join(home, "backups") });
    expect(names(readFileSync(join(home, "dump.pm2"), "utf8"))).toEqual(["quizmaster-web:online"]);
    expect(result.backup).toBeNull();
  });
});

describe("mergeDump", () => {
  const ours = APP_NAMES;

  it("nimmt bei defektem dump.pm2 die Sicherung .bak als gespeicherten Stand (wie pm2 resurrect)", () => {
    const result = mergeDump(
      { dump: "{kaputt", bak: dumpText([entry("fremde-a", "stopped")]) },
      dumpText([entry("fremde-a", "online"), entry("quizmaster-web", "online")]),
      ours,
    );
    expect(result.merged && names(result.text)).toEqual(["fremde-a:stopped", "quizmaster-web:online"]);
  });

  it("verweigert das Zusammenführen, wenn kein gespeicherter Stand lesbar ist", () => {
    const result = mergeDump({ dump: "{kaputt", bak: null }, dumpText([entry("quizmaster-web", "online")]), ours);
    expect(result).toMatchObject({ merged: false });
  });

  it("behält mehrfach vorhandene fremde Einträge (Cluster-Instanzen) und Einträge ohne Namen", () => {
    const previous = [entry("cluster", "online"), entry("cluster", "online"), { status: "online" } as Entry];
    const result = mergeDump(
      { dump: dumpText(previous), bak: null },
      dumpText([entry("quizmaster-realtime", "online")]),
      ours,
    );
    expect(result.merged && (JSON.parse(result.text) as Entry[]).length).toBe(4);
  });

  it("ein unlesbarer neuer Stand bricht ab (Datei bleibt, wie pm2 sie geschrieben hat)", () => {
    expect(mergeDump({ dump: dumpText([]), bak: null }, "nicht json", ours)).toMatchObject({ merged: false });
  });
});

describe("pruneDumpBackups", () => {
  it("behält die neuesten N dump.pm2-Sicherungen und rührt Caddy-/Cron-Sicherungen nie an", () => {
    const root = tempDir();
    const stamps = ["20261001-010000", "20261001-020000", "20261001-030000", "20261001-040000"];
    for (const stamp of stamps) {
      mkdirSync(join(root, stamp), { recursive: true });
      writeFileSync(join(root, stamp, "dump.pm2"), "[]");
    }
    mkdirSync(join(root, "20261001-010000", "caddy"));
    writeFileSync(join(root, "20261001-010000", "caddy", "Caddyfile"), "");
    mkdirSync(join(root, "20260930T180002Z"));
    writeFileSync(join(root, "20260930T180002Z", "dump.pm2"), "[]");

    expect(pruneDumpBackups(root, 2)).toBe(2);
    expect(existsSync(join(root, "20261001-040000", "dump.pm2"))).toBe(true);
    expect(existsSync(join(root, "20261001-030000", "dump.pm2"))).toBe(true);
    expect(existsSync(join(root, "20261001-020000"))).toBe(false);
    expect(existsSync(join(root, "20261001-010000", "dump.pm2"))).toBe(false);
    expect(existsSync(join(root, "20261001-010000", "caddy", "Caddyfile"))).toBe(true);
    expect(existsSync(join(root, "20260930T180002Z", "dump.pm2"))).toBe(true);
    expect(pruneDumpBackups(join(root, "fehlt"), 2)).toBe(0);
  });
});
