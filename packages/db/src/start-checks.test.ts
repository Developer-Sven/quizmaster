import type { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeMongoClient, createMongoClient, describeClientHosts, MONGO_POOL_SIZES } from "./client.ts";
import type { DbLogger } from "./logger.ts";
import { runStartChecks, StartCheckError, serverMajorVersion } from "./start-checks.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.cleanup();
});

function recordingLogger(): DbLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (message: string) => void lines.push(message);
  return { lines, info: push, warn: push, error: push };
}

/** Minimaler Client-Ersatz: beantwortet admin-Kommandos aus einer Tabelle. */
function fakeClient(replies: Record<string, () => Promise<unknown>>): MongoClient {
  return {
    options: { hosts: [{ toString: () => "db1.example.net:27017" }], srvHost: undefined },
    db: () => ({
      command: (command: Record<string, unknown>) => {
        const name = Object.keys(command)[0] ?? "";
        const reply = replies[name];
        if (!reply) return Promise.reject(new Error(`unerwartetes Kommando ${name}`));
        return reply();
      },
    }),
  } as unknown as MongoClient;
}

describe("runStartChecks", () => {
  it("besteht gegen das Replica Set der Test-Umgebung und loggt nur maskiert", async () => {
    const logger = recordingLogger();
    const result = await runStartChecks(t.client, { logger });
    expect(result.topology === "replicaSet" || result.topology === "sharded").toBe(true);
    expect(serverMajorVersion(result.serverVersion)).toBeGreaterThanOrEqual(7);
    const log = logger.lines.join("\n");
    expect(log).toMatch(/MongoDB ok/);
    expect(log).not.toContain(t.uri);
    expect(log).not.toMatch(/:\/\/[^*@\s]+:[^*@\s]+@/); // keine user:passwort@-Teile
  });

  it("bricht bei Standalone-Servern ab: „Change Streams brauchen ein Replica Set“", async () => {
    const client = fakeClient({
      ping: async () => ({ ok: 1 }),
      hello: async () => ({ isWritablePrimary: true }),
      buildInfo: async () => ({ version: "8.0.4" }),
    });
    await expect(runStartChecks(client)).rejects.toMatchObject({
      code: "NO_REPLICA_SET",
      message: expect.stringContaining("Change Streams brauchen ein Replica Set"),
    });
  });

  it("akzeptiert Sharded Cluster (isdbgrid) und warnt bei Version < 8.0", async () => {
    const logger = recordingLogger();
    const client = fakeClient({
      ping: async () => ({ ok: 1 }),
      hello: async () => ({ msg: "isdbgrid" }),
      buildInfo: async () => ({ version: "7.0.12" }),
    });
    const result = await runStartChecks(client, { logger });
    expect(result).toEqual({ serverVersion: "7.0.12", topology: "sharded", setName: null, versionRecommended: false });
    expect(logger.lines.join("\n")).toMatch(/7\.0\.12 < 8\.0/);
  });

  it("Ping-Timeout (5 s, hier verkürzt) und Ping-Fehler ergeben PING_FAILED ohne Zugangsdaten", async () => {
    const hanging = fakeClient({ ping: () => new Promise(() => undefined) });
    await expect(runStartChecks(hanging, { pingTimeoutMs: 50 })).rejects.toMatchObject({ code: "PING_FAILED" });
    const failing = fakeClient({ ping: async () => Promise.reject(new Error("Authentication failed.")) });
    const error = await runStartChecks(failing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StartCheckError);
    expect(String((error as Error).message)).toMatch(/db\*\*\*\.example\.net/);
  });
});

describe("createMongoClient", () => {
  const uri = "mongodb://user:geheim@db1.example.net:27017,db2.example.net:27017/?replicaSet=rs0";

  it("liefert je Prozess denselben Client (globalThis-Cache) und maskiert die URI im Log", async () => {
    const logger = recordingLogger();
    const first = createMongoClient(uri, { appName: "quizmaster-web", maxPoolSize: MONGO_POOL_SIZES.web, logger });
    const second = createMongoClient(uri, { appName: "quizmaster-web", maxPoolSize: MONGO_POOL_SIZES.web, logger });
    expect(second).toBe(first);
    expect(first.options.maxPoolSize).toBe(10);
    expect(first.options.serverSelectionTimeoutMS).toBe(5_000);
    expect(first.options.appName).toBe("quizmaster-web");
    const realtime = createMongoClient(uri, { appName: "quizmaster-realtime", maxPoolSize: MONGO_POOL_SIZES.realtime });
    expect(realtime).not.toBe(first);
    expect(realtime.options.maxPoolSize).toBe(20);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).not.toContain("geheim");
    expect(describeClientHosts(first)).not.toContain("geheim");
    await closeMongoClient(first);
    expect(createMongoClient(uri, { appName: "quizmaster-web", maxPoolSize: 10 })).not.toBe(first);
    const uncached = createMongoClient(uri, { appName: "quizmaster-web", maxPoolSize: 10, cache: false });
    expect(uncached).not.toBe(createMongoClient(uri, { appName: "quizmaster-web", maxPoolSize: 10 }));
  });

  it("lehnt ungültige URIs und Pool-Größen ab", () => {
    expect(() => createMongoClient("http://example.net", { appName: "x", maxPoolSize: 1 })).toThrow(/mongodb/);
    expect(() => createMongoClient(uri, { appName: "x", maxPoolSize: 0, cache: false })).toThrow(RangeError);
  });
});
