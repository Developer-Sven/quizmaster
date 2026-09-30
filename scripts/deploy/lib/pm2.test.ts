import { describe, expect, it } from "vitest";
import { parseJlist, pm2Messages } from "./pm2.ts";

const listing = JSON.stringify([
  {
    name: "fremde-app",
    pid: 11,
    pm2_env: { status: "online", restart_time: 0, env: { STRIPE_SECRET: "sk_live_geheim" } },
    monit: { memory: 1, cpu: 0 },
  },
  {
    name: "quizmaster-web",
    pid: 4242,
    pm2_env: { status: "online", restart_time: 3, pm_uptime: 1_700_000_000_000, env: { PATH: "/usr/bin" } },
    monit: { memory: 104_857_600, cpu: 1.5 },
  },
  { name: "quizmaster-realtime", pid: 0, pm2_env: { status: "errored" } },
]);

describe("parseJlist", () => {
  it("liefert nur die gewünschten Apps und nur unkritische Felder", () => {
    const apps = parseJlist(listing, ["quizmaster-web", "quizmaster-realtime"]);
    expect(apps).toEqual([
      {
        name: "quizmaster-web",
        pid: 4242,
        status: "online",
        restarts: 3,
        startedAt: 1_700_000_000_000,
        memoryBytes: 104_857_600,
        cpuPercent: 1.5,
      },
      {
        name: "quizmaster-realtime",
        pid: 0,
        status: "errored",
        restarts: 0,
        startedAt: null,
        memoryBytes: null,
        cpuPercent: null,
      },
    ]);
    expect(JSON.stringify(apps)).not.toContain("geheim");
  });

  it("überspringt vorangestellte pm2-Warnungen", () => {
    const noisy = `[PM2][WARN] Current process list is not synchronized with saved list.\n>>>> In-memory PM2 is out-of-date\n${listing}\n`;
    expect(parseJlist(noisy, ["quizmaster-web"])).toHaveLength(1);
    expect(parseJlist("[]\n", ["quizmaster-web"])).toEqual([]);
  });

  it("Parserfehler enthalten keinen Ausschnitt der Ausgabe (Env fremder Apps)", () => {
    const broken = `[{"name":"x","pm2_env":{"env":{"SECRET":"sk_live_geheim"}}\n]`;
    let message = "";
    try {
      parseJlist(broken, ["x"]);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("kein gültiges JSON");
    expect(message).not.toContain("geheim");
  });
});

describe("pm2Messages", () => {
  it("zeigt nur [PM2]-Zeilen (keine Tabellen mit fremden Apps) und entfernt Farben", () => {
    const messages = pm2Messages({
      code: 0,
      signal: null,
      timedOut: false,
      stdout:
        "\u001b[32m[PM2]\u001b[39m Applying action reloadProcessId on app [quizmaster-web]\n│ fremde-app │ online │\n",
      stderr: "[PM2][ERROR] Script not found\n",
    });
    expect(messages).toEqual([
      "[PM2] Applying action reloadProcessId on app [quizmaster-web]",
      "[PM2][ERROR] Script not found",
    ]);
  });
});
