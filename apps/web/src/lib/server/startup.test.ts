import { Writable } from "node:stream";
import { closeMongoClient, createMongoClient } from "@quizmaster/db";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseWebEnv, WebEnvError } from "../../env";
import { allowInsecureDatabaseTransport, WEB_APP_NAME } from "./db";
import { createLogger } from "./logger";
import { runWebStartupChecks } from "./startup";
import { TURNSTILE_TEST, testEnvSource } from "./test-support";

class ExitCalled extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    level: "info",
    destination: new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    }),
  });
  const exit = vi.fn((code: number): never => {
    throw new ExitCalled(code);
  });
  return { lines, logger, exit };
}

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await t?.cleanup();
});

describe("Start-Checks (instrumentation → runWebStartupChecks)", () => {
  it("ungültige Env → Exit 1 mit Liste der Probleme, ohne Werte", async () => {
    const { lines, logger, exit } = capture();
    const env = () => parseWebEnv(testEnvSource({ SESSION_SECRET: "kurz-aber-geheim", APP_ORIGIN: undefined }));
    await expect(runWebStartupChecks({ logger, exit, env })).rejects.toThrow(ExitCalled);
    expect(exit).toHaveBeenCalledWith(1);
    const text = lines.join("");
    expect(text).toContain("SESSION_SECRET");
    expect(text).toContain("APP_ORIGIN");
    expect(text).not.toContain("kurz-aber-geheim");
    expect(() => env()).toThrow(WebEnvError);
  });

  it("Test-Datenbank erreichbar → Checks bestehen (Replica Set)", async () => {
    const { logger, exit } = capture();
    const env = parseWebEnv(testEnvSource({ MONGODB_URI: t.uri, MONGODB_DB: t.dbName }));
    const result = await runWebStartupChecks({ logger, exit, env: () => env });
    expect(exit).not.toHaveBeenCalled();
    expect(["replicaSet", "sharded"]).toContain(result.topology);
    await closeMongoClient(createMongoClient(t.uri, { appName: WEB_APP_NAME, maxPoolSize: 10 }));
  });

  it("entfernter Host ohne TLS bei einer Nicht-Dev/Test-Datenbank → Exit 1 (fail-closed), Passwort nie im Log", async () => {
    const { lines, logger, exit } = capture();
    const uri = "mongodb://nutzer:supergeheim@db.example.invalid:27017/?replicaSet=rs0";
    const env = parseWebEnv(
      testEnvSource({
        MONGODB_URI: uri,
        MONGODB_DB: "quizmaster",
        TURNSTILE_SITE_KEY: TURNSTILE_TEST.siteKey,
        TURNSTILE_SECRET_KEY: TURNSTILE_TEST.secretKey,
      }),
    );
    await expect(runWebStartupChecks({ logger, exit, env: () => env })).rejects.toThrow(ExitCalled);
    const text = lines.join("");
    expect(text).toContain("TLS_REQUIRED");
    expect(text).toContain("Cloudflare-Testschlüssel");
    expect(text).not.toContain("supergeheim");
    expect(text).not.toContain("nutzer");
    await closeMongoClient(createMongoClient(uri, { appName: WEB_APP_NAME, maxPoolSize: 10 }));
  });

  it("TLS-Ausnahme nur für *_dev und *_test – nie an NODE_ENV gekoppelt", () => {
    expect(allowInsecureDatabaseTransport("quizmaster_dev")).toBe(true);
    expect(allowInsecureDatabaseTransport("quizmaster_test")).toBe(true);
    expect(allowInsecureDatabaseTransport("quizmaster")).toBe(false);
    expect(allowInsecureDatabaseTransport("quizmaster_prod")).toBe(false);
  });
});
