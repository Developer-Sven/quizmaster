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
    const env = parseWebEnv(testEnvSource({ MONGODB_URI: uri, MONGODB_DB: "quizmaster" }));
    await expect(runWebStartupChecks({ logger, exit, env: () => env })).rejects.toThrow(ExitCalled);
    const text = lines.join("");
    expect(text).toContain("TLS_REQUIRED");
    expect(text).not.toContain("supergeheim");
    expect(text).not.toContain("nutzer");
    await closeMongoClient(createMongoClient(uri, { appName: WEB_APP_NAME, maxPoolSize: 10 }));
  });

  it("Turnstile-Testschlüssel außerhalb von *_dev/*_test → Exit 1 (fatal) noch vor der Datenbank", async () => {
    const testKeys = { TURNSTILE_SITE_KEY: TURNSTILE_TEST.siteKey, TURNSTILE_SECRET_KEY: TURNSTILE_TEST.secretKey };
    // 1. über die Env-Regel (so startet der echte Prozess: getWebEnv → parseWebEnv)
    const viaEnv = capture();
    const fromSource = () => parseWebEnv(testEnvSource({ ...testKeys, MONGODB_DB: "quizmaster" }));
    await expect(runWebStartupChecks({ logger: viaEnv.logger, exit: viaEnv.exit, env: fromSource })).rejects.toThrow(
      ExitCalled,
    );
    expect(viaEnv.exit).toHaveBeenCalledWith(1);
    expect(viaEnv.lines.join("")).toContain("TURNSTILE_SECRET_KEY");

    // 2. Verteidigung in der Tiefe: auch eine anders entstandene Env bricht ab – ohne DB-Verbindung.
    const direct = capture();
    const base = parseWebEnv(testEnvSource({ ...testKeys, MONGODB_URI: "mongodb://db.example.invalid:27017/" }));
    const forged = { ...base, mongodbDb: "quizmaster" };
    await expect(runWebStartupChecks({ logger: direct.logger, exit: direct.exit, env: () => forged })).rejects.toThrow(
      ExitCalled,
    );
    expect(direct.exit).toHaveBeenCalledWith(1);
    const text = direct.lines.join("");
    expect(text).toContain("Cloudflare-Testschlüssel");
    expect(text).toContain('"level":60');
    expect(text).not.toContain("MongoDB-Start-Check");
    expect(text).not.toContain(TURNSTILE_TEST.secretKey);
  });

  it("Produktions-Datenbank ohne Turnstile → Warnungen beim Start (Bot-Schutz aus, Notfall-Schalter ohne Schlüssel)", async () => {
    // Remote-Host ohne TLS: Der Start endet danach am DB-Check – die Turnstile-Warnungen stehen schon vorher im Log.
    const prodWithout = { MONGODB_URI: "mongodb://db.example.invalid:27017/", MONGODB_DB: "quizmaster" };
    const off = capture();
    const env = parseWebEnv(testEnvSource(prodWithout));
    await expect(runWebStartupChecks({ logger: off.logger, exit: off.exit, env: () => env })).rejects.toThrow(
      ExitCalled,
    );
    const warnings = off.lines
      .map((line) => JSON.parse(line) as { level: number; msg: string })
      .filter((entry) => entry.level === 40 && entry.msg.includes("Turnstile"));
    expect(warnings.map((entry) => entry.msg)).toEqual([
      expect.stringContaining("TURNSTILE_ENABLED"),
      expect.stringContaining("turnstileOnJoin"),
    ]);

    // Eingeschaltet und vollständig konfiguriert: keine Warnung; Werte stehen nie im Log.
    const on = capture();
    const keys = { TURNSTILE_SITE_KEY: "0x4AAAAAAA-site-key", TURNSTILE_SECRET_KEY: "0x4AAAAAAA-secret-key-value" };
    const configured = parseWebEnv(testEnvSource({ ...prodWithout, TURNSTILE_ENABLED: "true", ...keys }));
    await expect(runWebStartupChecks({ logger: on.logger, exit: on.exit, env: () => configured })).rejects.toThrow(
      ExitCalled,
    );
    expect(on.lines.join("")).not.toContain("Turnstile");
    expect(on.lines.join("")).not.toContain(keys.TURNSTILE_SECRET_KEY);

    // Ausgeschaltet, aber Schlüssel vorhanden (Notfall-Schalter funktioniert): nur der Hinweis „Bot-Schutz aus“.
    const keysOnly = capture();
    const standby = parseWebEnv(testEnvSource({ ...prodWithout, ...keys }));
    await expect(
      runWebStartupChecks({ logger: keysOnly.logger, exit: keysOnly.exit, env: () => standby }),
    ).rejects.toThrow(ExitCalled);
    expect(keysOnly.lines.filter((line) => line.includes("Turnstile") && line.includes('"level":40'))).toHaveLength(1);
    await closeMongoClient(createMongoClient(prodWithout.MONGODB_URI, { appName: WEB_APP_NAME, maxPoolSize: 10 }));
  });

  it("Dev-/Test-Datenbank ohne Turnstile → keine Warnung (docs/06: Dev mit TURNSTILE_ENABLED=false)", async () => {
    const { lines, logger, exit } = capture();
    const env = parseWebEnv(testEnvSource({ MONGODB_URI: t.uri, MONGODB_DB: t.dbName }));
    await runWebStartupChecks({ logger, exit, env: () => env });
    expect(exit).not.toHaveBeenCalled();
    expect(lines.join("")).not.toContain("Turnstile");
  });

  it("TLS-Ausnahme nur für *_dev und *_test – nie an NODE_ENV gekoppelt", () => {
    expect(allowInsecureDatabaseTransport("quizmaster_dev")).toBe(true);
    expect(allowInsecureDatabaseTransport("quizmaster_test")).toBe(true);
    expect(allowInsecureDatabaseTransport("quizmaster")).toBe(false);
    expect(allowInsecureDatabaseTransport("quizmaster_prod")).toBe(false);
  });
});
