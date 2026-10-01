import type { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONNECT_TIMEOUT_MS,
  clientTransport,
  closeMongoClient,
  createMongoClient,
  describeClientHosts,
  MONGO_POOL_SIZES,
  SOCKET_TIMEOUT_MS,
} from "./client.ts";
import type { DbLogger } from "./logger.ts";
import {
  knownServerVulnerabilities,
  MONGODB_SERVER_ADVISORIES,
  patchTarget,
  runStartChecks,
  StartCheckError,
  serverMajorVersion,
} from "./start-checks.ts";
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

/** Minimaler Client-Ersatz: beantwortet admin-Kommandos aus einer Tabelle (Standard: entfernter Host mit TLS). */
function fakeClient(
  replies: Record<string, () => Promise<unknown>>,
  options: Record<string, unknown> = { tls: true },
): MongoClient {
  return {
    options: {
      hosts: [{ host: "db1.example.net", port: 27017, toString: () => "db1.example.net:27017" }],
      srvHost: undefined,
      ...options,
    },
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
    // Lokal läuft die Test-DB auf dem Dev-Cluster (noch ohne TLS, siehe env:check) – nur hier erlaubt.
    const result = await runStartChecks(t.client, { logger, allowInsecureTransport: true });
    expect(result.topology === "replicaSet" || result.topology === "sharded").toBe(true);
    if (t.source === "memory") expect(result.transport).toBe("loopback");
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
    expect(result).toEqual({
      serverVersion: "7.0.12",
      topology: "sharded",
      setName: null,
      versionRecommended: false,
      knownVulnerabilities: ["CVE-2025-14847 (MongoBleed)"],
      transport: "tls",
    });
    expect(logger.lines.join("\n")).toMatch(/7\.0\.12 < 8\.0/);
  });

  it("warnt bei einem ungepatchten Server (CVE-2025-14847 „MongoBleed“) mit Ziel-Version, startet aber", async () => {
    const reply = (version: string) =>
      fakeClient({
        ping: async () => ({ ok: 1 }),
        hello: async () => ({ setName: "rs0" }),
        buildInfo: async () => ({ version }),
      });
    const vulnerable = recordingLogger();
    const result = await runStartChecks(reply("8.0.4"), { logger: vulnerable });
    expect(result).toMatchObject({ versionRecommended: true, knownVulnerabilities: ["CVE-2025-14847 (MongoBleed)"] });
    const warning = vulnerable.lines.find((line) => line.includes("CVE-2025-14847"));
    expect(warning).toContain("MongoDB 8.0.4");
    expect(warning).toContain("8.0.17");

    const patched = recordingLogger();
    expect(await runStartChecks(reply("8.0.17"), { logger: patched })).toMatchObject({ knownVulnerabilities: [] });
    expect(patched.lines.join("\n")).not.toContain("CVE-");

    const unknown = recordingLogger();
    expect(await runStartChecks(reply("unbekannt"), { logger: unknown })).toMatchObject({
      knownVulnerabilities: null,
    });
    expect(unknown.lines.join("\n")).toMatch(/Patchstand.*nicht prüfbar/);
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

describe("runStartChecks – Transportverschlüsselung (docs/04, 06, 12: TLS erzwingen)", () => {
  const replies = {
    ping: async () => ({ ok: 1 }),
    hello: async () => ({ setName: "rs0" }),
    buildInfo: async () => ({ version: "8.0.4" }),
  };

  it.each([
    ["ohne TLS", "mongodb://user:geheim@db1.example.net:27017/?replicaSet=rs0"],
    [
      "ohne Zertifikatsprüfung",
      "mongodb://user:geheim@db1.example.net:27017/?tls=true&tlsAllowInvalidCertificates=true",
    ],
    ["ohne Hostnamenprüfung", "mongodb://user:geheim@db1.example.net:27017/?tls=true&tlsAllowInvalidHostnames=true"],
    ["tlsInsecure", "mongodb://user:geheim@db1.example.net:27017/?tls=true&tlsInsecure=true"],
    ["SRV mit tls=false", "mongodb+srv://user:geheim@cluster.example.net/?tls=false"],
  ])("bricht %s vor dem ersten Kommando ab (keine Zugangsdaten im Klartext)", async (_label, uri) => {
    const client = createMongoClient(uri, { appName: "quizmaster-test-tls", maxPoolSize: 1, cache: false });
    try {
      const started = Date.now();
      const error = await runStartChecks(client).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(StartCheckError);
      expect(error).toMatchObject({ code: "TLS_REQUIRED" });
      expect(String((error as Error).message)).not.toContain("geheim");
      // Ohne Verbindungsversuch (sonst wartete die Server-Auswahl bis zu 5 s).
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await closeMongoClient(client);
    }
  });

  it("erkennt TLS, lokale Hosts und unsichere Verbindungen anhand der Treiber-Optionen", async () => {
    const transport = (uri: string) => {
      const client = createMongoClient(uri, { appName: "quizmaster-test-tls", maxPoolSize: 1, cache: false });
      const result = clientTransport(client);
      void client.close();
      return result;
    };
    expect(transport("mongodb://db1.example.net:27017/?tls=true")).toBe("tls");
    expect(transport("mongodb+srv://cluster.example.net/?retryWrites=true")).toBe("tls");
    expect(transport("mongodb://127.0.0.1:27017,localhost:27018/?replicaSet=rs0")).toBe("loopback");
    expect(transport("mongodb://%2Ftmp%2Fmongodb-27017.sock/?replicaSet=rs0")).toBe("loopback");
    expect(transport("mongodb://localhost:27017,db1.example.net:27017/?replicaSet=rs0")).toBe("insecure");
    expect(transport("mongodb://db1.example.net:27017/?tls=true&tlsInsecure=true")).toBe("insecure");
  });

  it("lokale Hosts brauchen kein TLS; allowInsecureTransport (nur Entwicklung) warnt statt abzubrechen", async () => {
    const local = fakeClient(replies, {
      tls: undefined,
      hosts: [{ host: "127.0.0.1", port: 27017, toString: () => "127.0.0.1:27017" }],
    });
    expect((await runStartChecks(local)).transport).toBe("loopback");

    const remote = fakeClient(replies, { tls: undefined });
    await expect(runStartChecks(remote)).rejects.toMatchObject({ code: "TLS_REQUIRED" });
    const logger = recordingLogger();
    expect((await runStartChecks(remote, { logger, allowInsecureTransport: true })).transport).toBe("insecure");
    expect(logger.lines.join("\n")).toMatch(/ohne \(geprüftes\) TLS/);
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
    expect(first.options.socketTimeoutMS).toBe(SOCKET_TIMEOUT_MS);
    expect(first.options.connectTimeoutMS).toBe(CONNECT_TIMEOUT_MS);
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

  it("begrenzt Verbindungsaufbau und Socket-Wartezeit (überschreibbar für Skripte)", () => {
    expect(SOCKET_TIMEOUT_MS).toBe(30_000);
    expect(CONNECT_TIMEOUT_MS).toBe(10_000);
    const script = createMongoClient(uri, {
      appName: "quizmaster-seed",
      maxPoolSize: 1,
      cache: false,
      driverOptions: { socketTimeoutMS: 120_000 },
    });
    expect(script.options.socketTimeoutMS).toBe(120_000);
    expect(script.options.connectTimeoutMS).toBe(CONNECT_TIMEOUT_MS);
    void script.close();
  });

  it("lehnt ungültige URIs und Pool-Größen ab", () => {
    expect(() => createMongoClient("http://example.net", { appName: "x", maxPoolSize: 1 })).toThrow(/mongodb/);
    expect(() => createMongoClient(uri, { appName: "x", maxPoolSize: 0, cache: false })).toThrow(RangeError);
  });
});

describe("knownServerVulnerabilities (Patchstand, docs/03 + docs/06)", () => {
  it("kennt die Mindestversionen je Release-Linie für CVE-2025-14847 („MongoBleed“)", () => {
    const vulnerable = ["CVE-2025-14847 (MongoBleed)"];
    const cases: Array<[string, string[] | null]> = [
      ["8.0.16", vulnerable],
      ["8.0.17", []],
      ["8.0.20", []],
      ["8.0.17-rc0", vulnerable],
      ["8.1.2", vulnerable], // Rapid Release ohne Fix auf der Linie
      ["8.2.2", vulnerable],
      ["8.2.3", []],
      ["8.3.0", []],
      ["9.0.1", []],
      ["7.0.27", vulnerable],
      ["7.0.28", []],
      ["7.3.4", vulnerable],
      ["6.0.27", []],
      ["5.0.31", vulnerable],
      ["4.4.30", []],
      ["4.2.25", vulnerable],
      ["3.6.23", vulnerable],
      ["unbekannt", null],
      ["8", null],
      ["", null],
    ];
    for (const [version, expected] of cases) expect(knownServerVulnerabilities(version), version).toEqual(expected);
    expect(MONGODB_SERVER_ADVISORIES.map((advisory) => advisory.id)).toContain("CVE-2025-14847");
  });

  it("nennt als Ziel den Patch der eigenen Linie, sonst die gepatchten Linien", () => {
    expect(patchTarget("8.0.4")).toBe("mindestens 8.0.17");
    expect(patchTarget("8.2.1")).toBe("mindestens 8.2.3");
    expect(patchTarget("7.0.12")).toBe("mindestens 7.0.28");
    expect(patchTarget("8.1.2")).toBe("eine gepatchte Version (8.0 ≥ 8.0.17, 8.2 ≥ 8.2.3 oder ≥ 8.3)");
    expect(patchTarget("kaputt")).toBe("eine gepatchte Version (8.0 ≥ 8.0.17, 8.2 ≥ 8.2.3 oder ≥ 8.3)");
  });
});
