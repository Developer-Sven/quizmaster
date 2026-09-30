import { describe, expect, it } from "vitest";
import { maskMongoUri } from "./file.ts";
import { mongoUriTransport } from "./mongo-uri.ts";
import { realtimeProcessEnv, resolveEnv, watchdogProcessEnv, webProcessEnv } from "./resolve.ts";
import { checkSourceRules, type SourceEnv, sourceEnvSchema, sourceWarnings } from "./schema.ts";

const secret = (seed: string) => seed.repeat(40).slice(0, 43);

function source(overrides: Record<string, string> = {}): SourceEnv {
  return sourceEnvSchema.parse({
    MONGODB_URI: "mongodb://user:pass@db.example.net:27017/?replicaSet=rs0",
    MONGODB_DB: "quizmaster_dev",
    SESSION_SECRET: secret("a"),
    REALTIME_TICKET_SECRET: secret("b"),
    IP_HASH_SECRET: secret("c"),
    METRICS_TOKEN: secret("d"),
    ...overrides,
  });
}

const prodSource = (overrides: Record<string, string> = {}) =>
  source({
    QUIZMASTER_DOMAIN: "quiz.example.com",
    QUIZMASTER_PORT: "7400",
    TLS_CERT_FILE: "/etc/ssl/origin.pem",
    TLS_KEY_FILE: "/etc/ssl/origin.key",
    TRUSTED_IP_HEADER: "cf-connecting-ip",
    MONGODB_URI: "mongodb://user:pass@db.example.net:27017/?replicaSet=rs0&tls=true",
    MONGODB_DB: "quizmaster",
    BACKUP_PASSPHRASE: secret("e"),
    DEV_BOTS_ENABLED: "false",
    ...overrides,
  });

describe("resolveEnv", () => {
  it("leitet für dev localhost-Origins aus den Ports ab", () => {
    const env = resolveEnv(source({ QUIZMASTER_PORT: "3000", REALTIME_PORT: "4000" }), "dev");
    expect(env.appOrigin).toBe("http://localhost:3000");
    expect(env.realtimeUrl).toBe("http://localhost:4000");
    expect(env.realtimePort).toBe(4000);
  });

  it("leitet für prod die https-Origin aus der Domain ab, Realtime auf gleicher Origin und Port + 1", () => {
    const env = resolveEnv(prodSource(), "prod");
    expect(env.appOrigin).toBe("https://quiz.example.com");
    expect(env.realtimeUrl).toBe("");
    expect(env.webPort).toBe(7400);
    expect(env.realtimePort).toBe(7401);
  });

  it("übernimmt mehrere Origins aus APP_ORIGIN und nutzt die erste als kanonische", () => {
    const env = resolveEnv(prodSource({ APP_ORIGIN: "https://a.example.com, https://b.example.com" }), "prod");
    expect(env.appOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(env.appOrigin).toBe("https://a.example.com");
  });
});

describe("Prozess-Env je App (Least Privilege)", () => {
  const env = resolveEnv(
    prodSource({ TURNSTILE_SECRET_KEY: "turnstile", ALERT_WEBHOOK_URL: "https://hooks.example.com/x" }),
    "prod",
  );

  it("gibt Web keine Realtime- oder Backup-Secrets", () => {
    const web = webProcessEnv(env);
    expect(web.PORT).toBe("7400");
    expect(web.HOSTNAME).toBe("127.0.0.1");
    expect(web).not.toHaveProperty("METRICS_TOKEN");
    expect(web).not.toHaveProperty("BACKUP_PASSPHRASE");
    expect(web).not.toHaveProperty("ALERT_WEBHOOK_URL");
  });

  it("gibt Realtime weder Session- noch Turnstile-Secret", () => {
    const realtime = realtimeProcessEnv(env);
    expect(realtime.REALTIME_PORT).toBe("7401");
    expect(realtime.HOST).toBe("127.0.0.1");
    expect(realtime).not.toHaveProperty("SESSION_SECRET");
    expect(realtime).not.toHaveProperty("TURNSTILE_SECRET_KEY");
  });

  it("gibt dem Watchdog nur Health-/Metrik-Ziele, Token und Webhook", () => {
    const watchdog = watchdogProcessEnv(env);
    expect(watchdog.REALTIME_METRICS_URL).toBe("http://127.0.0.1:7401/metrics");
    expect(watchdog).not.toHaveProperty("MONGODB_URI");
    expect(watchdog).not.toHaveProperty("SESSION_SECRET");
  });
});

describe("checkSourceRules", () => {
  it("akzeptiert eine vollständige Produktions-Env", () => {
    expect(checkSourceRules(prodSource(), "prod")).toEqual([]);
  });

  it("lehnt in Produktion Dev-Bots, fast-Timing, Test-Präfix und fehlenden IP-Header ab (fail-closed)", () => {
    const problems = checkSourceRules(
      prodSource({ DEV_BOTS_ENABLED: "true", GAME_TIMING: "fast", TRUSTED_IP_HEADER: "" }),
      "prod",
    ).map((problem) => problem.split(":")[0]);
    expect(problems).toEqual(expect.arrayContaining(["DEV_BOTS_IN_PROD", "FAST_TIMING_IN_PROD", "IP_HEADER_MISSING"]));
  });

  it("erlaubt Collection-Präfixe nur in *_test-Datenbanken", () => {
    expect(checkSourceRules(source({ MONGODB_COLLECTION_PREFIX: "t_abc" }), "dev")).toContainEqual(
      expect.stringMatching(/^PREFIX_OUTSIDE_TEST_DB/),
    );
    expect(
      checkSourceRules(source({ MONGODB_DB: "quizmaster_test", MONGODB_COLLECTION_PREFIX: "t_abc" }), "dev"),
    ).toEqual([]);
  });

  it("verlangt verschiedene Secrets je Zweck", () => {
    expect(checkSourceRules(source({ IP_HASH_SECRET: secret("a") }), "dev")).toContainEqual(
      expect.stringMatching(/^SECRETS_NOT_DISTINCT/),
    );
  });

  it("verlangt Turnstile-Keys, sobald Turnstile aktiv ist", () => {
    expect(checkSourceRules(source({ TURNSTILE_ENABLED: "true" }), "dev")).toContainEqual(
      expect.stringMatching(/^TURNSTILE_KEYS_MISSING/),
    );
  });

  it("verlangt in Produktion TLS mit Zertifikatsprüfung zur Datenbank (fail-closed, außer rein lokal)", () => {
    const tlsProblem = (uri: string) =>
      checkSourceRules(prodSource({ MONGODB_URI: uri }), "prod").some((problem) => problem.startsWith("MONGODB_TLS:"));
    expect(tlsProblem("mongodb://user:pass@db.example.net:27017/?replicaSet=rs0")).toBe(true);
    expect(tlsProblem("mongodb://user:pass@db.example.net:27017/?tls=true&tlsAllowInvalidCertificates=true")).toBe(
      true,
    );
    expect(tlsProblem("mongodb://user:pass@db.example.net:27017/?ssl=true&tlsInsecure=true")).toBe(true);
    expect(tlsProblem("mongodb+srv://user:pass@cluster.example.net/?tls=false")).toBe(true);
    expect(tlsProblem("mongodb://user:pass@db.example.net:27017/?replicaSet=rs0&tls=true")).toBe(false);
    expect(tlsProblem("mongodb+srv://user:pass@cluster.example.net/?retryWrites=true&w=majority")).toBe(false);
    expect(tlsProblem("mongodb://user:pass@127.0.0.1:27017/?replicaSet=rs0")).toBe(false);
  });

  it("warnt in dev bei unverschlüsselter Verbindung zu entfernten Hosts", () => {
    const warnings = (uri: string) => sourceWarnings(source({ MONGODB_URI: uri }), "dev");
    expect(warnings("mongodb://user:pass@db.example.net:27017/?replicaSet=rs0")).toContainEqual(
      expect.stringMatching(/^MONGODB_TLS_OFF:/),
    );
    expect(warnings("mongodb://user:pass@db.example.net:27017/?replicaSet=rs0&tls=true")).toEqual([]);
    expect(warnings("mongodb://localhost:27017,[::1]:27018/?replicaSet=rs0")).toEqual([]);
  });

  it("beschränkt dev auf *_dev- und *_test-Datenbanken", () => {
    expect(checkSourceRules(source({ MONGODB_DB: "quizmaster" }), "dev")).toContainEqual(
      expect.stringMatching(/^DB_NAME:/),
    );
    expect(checkSourceRules(source({ MONGODB_DB: "quizmaster_test" }), "dev")).toEqual([]);
    expect(checkSourceRules(source(), "dev")).toEqual([]);
  });

  it("warnt in Produktion bei ausgeschaltetem Turnstile und fehlendem Alarm-Webhook", () => {
    expect(sourceWarnings(prodSource(), "prod").map((warning) => warning.split(":")[0])).toEqual([
      "TURNSTILE_DISABLED",
      "ALERTS_DISABLED",
    ]);
  });
});

describe("sourceEnvSchema", () => {
  it("lehnt kurze Secrets und fremde URI-Schemata ab", () => {
    expect(sourceEnvSchema.safeParse({ ...source(), SESSION_SECRET: "kurz" }).success).toBe(false);
    expect(sourceEnvSchema.safeParse({ ...source(), MONGODB_URI: "postgres://x" }).success).toBe(false);
  });

  it("behandelt leere Werte als nicht gesetzt", () => {
    expect(source({ QUIZMASTER_DOMAIN: "", REALTIME_URL: "" }).QUIZMASTER_DOMAIN).toBeUndefined();
  });
});

describe("maskMongoUri", () => {
  it("entfernt Zugangsdaten, Query und kürzt Hostnamen", () => {
    const masked = maskMongoUri(
      "mongodb://admin:geheim@mongo.example.net:27017,mongo2.example.net:27017/?replicaSet=rs0",
    );
    expect(masked).not.toContain("geheim");
    expect(masked).not.toContain("admin");
    expect(masked).not.toContain("replicaSet");
    expect(masked).toBe("mongodb://***@mo***.example.net:27017,mo***.example.net:27017");
  });
});

describe("mongoUriTransport", () => {
  it("erkennt TLS (mongodb+srv:// standardmäßig, sonst tls/ssl=true), Prüfungs-Abschaltungen und lokale Hosts", () => {
    expect(mongoUriTransport("mongodb://u:p@db.example.net:27017/?replicaSet=rs0")).toEqual({
      tls: false,
      verified: false,
      loopbackOnly: false,
    });
    expect(mongoUriTransport("mongodb://u:p@db.example.net:27017/?TLS=TRUE")).toMatchObject({
      tls: true,
      verified: true,
    });
    expect(mongoUriTransport("mongodb://db.example.net/?ssl=true")).toMatchObject({ tls: true, verified: true });
    expect(mongoUriTransport("mongodb://db.example.net/?tls=true&ssl=false")).toMatchObject({ tls: false });
    expect(mongoUriTransport("mongodb://db.example.net/?tls=true&tlsAllowInvalidHostnames=true")).toMatchObject({
      tls: true,
      verified: false,
    });
    expect(mongoUriTransport("mongodb+srv://u:p@cluster.example.net/")).toMatchObject({ tls: true, verified: true });
    expect(mongoUriTransport("mongodb+srv://u:p@cluster.example.net/?ssl=false").tls).toBe(false);
    expect(mongoUriTransport("mongodb://127.0.0.2:27017,localhost/?replicaSet=rs0").loopbackOnly).toBe(true);
    expect(mongoUriTransport("mongodb://%2Ftmp%2Fmongodb-27017.sock/?replicaSet=rs0").loopbackOnly).toBe(true);
    expect(mongoUriTransport("mongodb://localhost,db.example.net/?replicaSet=rs0").loopbackOnly).toBe(false);
    expect(mongoUriTransport("mongodb://u:p%3F%40@[::1]:27017/?replicaSet=rs0").loopbackOnly).toBe(true);
    expect(mongoUriTransport("kein-mongo")).toEqual({ tls: false, verified: false, loopbackOnly: false });
  });
});

describe("Produktion verlangt https-Origins", () => {
  it("lehnt http in APP_ORIGIN und REALTIME_URL ab", () => {
    const problems = checkSourceRules(
      prodSource({ APP_ORIGIN: "http://quiz.example.com", REALTIME_URL: "http://rt.example.com" }),
      "prod",
    ).map((problem) => problem.split(":")[0]);
    expect(problems).toEqual(expect.arrayContaining(["ORIGIN_NOT_HTTPS", "REALTIME_URL_NOT_HTTPS"]));
  });
});
