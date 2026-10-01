/**
 * Prozess-Einstieg `src/index.ts` als echter Kindprozess gegen die Test-DB: Env → Start-Checks →
 * ensureIndexes → listen → `process.send("ready")` (pm2 `wait_ready`), SIGTERM → geordnetes Ende mit Exit 0
 * in < 10 s. Die Logs enthalten weder URI noch Secrets. (Zweites Signal, harte Frist und unbehandelte Fehler:
 * `installProcessShutdown` in shutdown.test.ts – dort deterministisch ohne Signal-Wettlauf.)
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_TEST_PORTS } from "../helpers/index.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const ENTRY = resolve(import.meta.dirname, "../../src/index.ts");

async function freePort(): Promise<number> {
  for (let port = DEFAULT_TEST_PORTS.to; port >= DEFAULT_TEST_PORTS.from; port--) {
    const probe = createServer();
    const free = await new Promise<boolean>((done) => {
      probe.once("error", () => done(false));
      probe.listen(port, "127.0.0.1", () => done(true));
    });
    if (free) {
      await new Promise<void>((done) => probe.close(() => done()));
      return port;
    }
  }
  throw new Error("Kein freier Port im Testbereich");
}

interface RunningServer {
  child: ChildProcess;
  port: number;
  output: () => string;
}

describe("index.ts (Kindprozess)", () => {
  let database: TestDatabase;
  const secrets = {
    ticket: randomBytes(32).toString("base64url"),
    ipHash: randomBytes(32).toString("base64url"),
    metrics: randomBytes(32).toString("base64url"),
  };

  const children = new Set<ChildProcess>();

  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterEach(() => {
    // Nie einen Server-Prozess zurücklassen, auch wenn eine Erwartung scheitert.
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    children.clear();
  });
  afterAll(() => database?.cleanup());

  async function launch(): Promise<RunningServer> {
    const port = await freePort();
    const child = spawn(process.execPath, [ENTRY], {
      env: {
        PATH: process.env.PATH ?? "",
        HOST: "127.0.0.1",
        REALTIME_PORT: String(port),
        APP_ORIGIN: "http://localhost:3000",
        MONGODB_URI: database.uri,
        MONGODB_DB: database.dbName,
        MONGODB_COLLECTION_PREFIX: database.prefix,
        REALTIME_TICKET_SECRET: secrets.ticket,
        IP_HASH_SECRET: secrets.ipHash,
        METRICS_TOKEN: secrets.metrics,
        GAME_TIMING: "fast",
        LOG_LEVEL: "info",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.add(child);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const ready = new Promise<void>((resolveReady, reject) => {
      child.once("message", (message) => {
        if (message === "ready") resolveReady();
        else reject(new Error(`Unerwartete Nachricht: ${String(message)}`));
      });
      child.once("exit", (code) => reject(new Error(`Prozess vor „ready“ beendet (Exit ${code}):\n${output}`)));
    });
    await ready;
    return { child, port, output: () => output };
  }

  function expectCleanLogs(output: string) {
    for (const secret of [database.uri, secrets.ticket, secrets.ipHash, secrets.metrics]) {
      expect(output.includes(secret)).toBe(false);
    }
  }

  it("meldet ready, bedient /healthz und beendet sich bei SIGTERM mit Exit 0 in < 10 s", async () => {
    const server = await launch();
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const exited = once(server.child, "exit");
    const started = performance.now();
    server.child.kill("SIGTERM");
    const [code] = (await exited) as [number | null];
    expect(code).toBe(0);
    expect(performance.now() - started).toBeLessThan(10_000);

    const output = server.output();
    expect(output).toContain("Realtime-Server bereit");
    expect(output).toContain("Realtime-Server gestoppt");
    expectCleanLogs(output);
  });
});
