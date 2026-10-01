import { describe, expect, it } from "vitest";
import {
  baseChildEnv,
  createStackSecrets,
  DEFAULT_REALTIME_PORT,
  DEFAULT_WEB_PORT,
  parseStackArgs,
  realtimeStackEnv,
  redactSecrets,
  WEB_DIST_DIR,
  webStackEnv,
} from "./stack-config.ts";

const database = {
  uri: "mongodb://user:geheim@db.example.net:27017/?replicaSet=rs0",
  dbName: "quizmaster_test",
  prefix: "t2610010900_abc123_",
};
const secrets = createStackSecrets();
const parent = {
  PATH: "/usr/bin",
  HOME: "/root",
  NODE_OPTIONS: "--max-old-space-size=3072",
  MONGODB_URI: "mongodb://dev-cluster/",
  TEST_MONGODB_URI: "mongodb://test-cluster/",
  SESSION_SECRET: "aus-der-shell-aus-der-shell-aus-der-shell",
  TRUSTED_IP_HEADER: "cf-connecting-ip",
  TURNSTILE_SECRET_KEY: "x",
  QUIZMASTER_DOMAIN: "quiz.example.com",
  FORCE_COLOR: "1",
};
const input = { parent, ports: { webPort: 3205, realtimePort: 4205 }, database, secrets, logLevel: "info" as const };

describe("parseStackArgs", () => {
  it("nutzt Standard-Ports, baut und legt Logs je Port ins Temp-Verzeichnis", () => {
    const result = parseStackArgs([], "/repo");
    expect(result).toMatchObject({
      ok: true,
      options: { webPort: DEFAULT_WEB_PORT, realtimePort: DEFAULT_REALTIME_PORT, build: true, logLevel: "info" },
    });
    if (result.ok) expect(result.options.logDir).toMatch(/quizmaster-stack-test[/\\]3200$/);
  });

  it("liest Ports, --no-build und löst relative Log-Ordner ab cwd auf", () => {
    const result = parseStackArgs(
      ["--web-port", "3201", "--realtime-port", "4201", "--no-build", "--log-dir", "logs/e2e", "--log-level", "warn"],
      "/repo",
    );
    expect(result).toEqual({
      ok: true,
      options: {
        webPort: 3201,
        realtimePort: 4201,
        build: false,
        logDir: "/repo/logs/e2e",
        logLevel: "warn",
        help: false,
      },
    });
  });

  it("lehnt ungültige Ports, gleiche Ports, unbekannte Optionen und Log-Level ab", () => {
    expect(parseStackArgs(["--web-port", "80"]).ok).toBe(false);
    expect(parseStackArgs(["--web-port", "abc"]).ok).toBe(false);
    expect(parseStackArgs(["--web-port", "4000", "--realtime-port", "4000"]).ok).toBe(false);
    expect(parseStackArgs(["--port", "3000"]).ok).toBe(false);
    expect(parseStackArgs(["--log-level", "trace"]).ok).toBe(false);
    expect(parseStackArgs(["extra"]).ok).toBe(false);
  });
});

describe("Prozess-Env", () => {
  it("übernimmt keine App-Schlüssel aus der Eltern-Env", () => {
    const env = baseChildEnv(parent);
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/root", NODE_OPTIONS: "--max-old-space-size=3072" });
    for (const key of [
      "MONGODB_URI",
      "TEST_MONGODB_URI",
      "SESSION_SECRET",
      "TRUSTED_IP_HEADER",
      "TURNSTILE_SECRET_KEY",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env).not.toHaveProperty("QUIZMASTER_DOMAIN");
    // Logdateien ohne Farbcodes.
    expect(env).not.toHaveProperty("FORCE_COLOR");
    expect(env.NO_COLOR).toBe("1");
  });

  it("Realtime: Test-DB mit Präfix, fast, Dev-Bots, relaxed, Origin = Web des Stacks", () => {
    const env = realtimeStackEnv(input);
    expect(env).toMatchObject({
      HOST: "127.0.0.1",
      REALTIME_PORT: "4205",
      APP_ORIGIN: "http://127.0.0.1:3205",
      MONGODB_URI: database.uri,
      MONGODB_DB: "quizmaster_test",
      MONGODB_COLLECTION_PREFIX: database.prefix,
      REALTIME_TICKET_SECRET: secrets.realtimeTicket,
      IP_HASH_SECRET: secrets.ipHash,
      METRICS_TOKEN: secrets.metrics,
      GAME_TIMING: "fast",
      DEV_BOTS_ENABLED: "true",
      RATE_LIMIT_MODE: "relaxed",
    });
    expect(env).not.toHaveProperty("SESSION_SECRET");
    expect(env).not.toHaveProperty("TRUSTED_IP_HEADER");
  });

  it("Web: gleiche Ticket-/IP-Secrets, Realtime-URL, Turnstile aus, eigenes Build-Verzeichnis", () => {
    const env = webStackEnv(input);
    expect(env).toMatchObject({
      NEXT_DIST_DIR: WEB_DIST_DIR,
      PORT: "3205",
      HOSTNAME: "127.0.0.1",
      APP_ORIGIN: "http://127.0.0.1:3205",
      REALTIME_URL: "http://127.0.0.1:4205",
      MONGODB_COLLECTION_PREFIX: database.prefix,
      SESSION_SECRET: secrets.session,
      REALTIME_TICKET_SECRET: secrets.realtimeTicket,
      IP_HASH_SECRET: secrets.ipHash,
      TURNSTILE_ENABLED: "false",
      DEV_BOTS_ENABLED: "true",
      RATE_LIMIT_MODE: "relaxed",
    });
    expect(env).not.toHaveProperty("METRICS_TOKEN");
    expect(env).not.toHaveProperty("TURNSTILE_SECRET_KEY");
  });
});

describe("Secrets", () => {
  it("erzeugt vier verschiedene Secrets mit mindestens 32 Zeichen", () => {
    const values = Object.values(createStackSecrets());
    expect(new Set(values).size).toBe(4);
    for (const value of values) expect(value.length).toBeGreaterThanOrEqual(32);
  });

  it("bricht ab, wenn der Zufall gleiche Werte liefert", () => {
    expect(() => createStackSecrets(() => Buffer.alloc(32, 1))).toThrow();
  });

  it("entfernt URI und Secrets aus Log-Auszügen", () => {
    const text = `connect ${database.uri} failed, token ${secrets.metrics}`;
    const redacted = redactSecrets(text, [database.uri, secrets.metrics]);
    expect(redacted).not.toContain("geheim");
    expect(redacted).not.toContain(secrets.metrics);
    expect(redacted).toBe("connect *** failed, token ***");
  });
});
