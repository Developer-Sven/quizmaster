/** Env des Realtime-Prozesses: Vertrag mit `realtimeProcessEnv()`, Defaults und fail-closed-Regeln. */
import { realtimeProcessEnv, resolveEnv, sourceEnvSchema } from "@quizmaster/shared/env";
import { describe, expect, it } from "vitest";
import { databaseKindOf, parseRealtimeEnv } from "../../src/env.ts";

const secret = (char: string) => char.repeat(40);

const minimal: Record<string, string> = {
  REALTIME_PORT: "4131",
  APP_ORIGIN: "http://localhost:3000",
  MONGODB_URI: "mongodb://db.example:27017/?replicaSet=rs0",
  MONGODB_DB: "quizmaster_dev",
  REALTIME_TICKET_SECRET: secret("a"),
  IP_HASH_SECRET: secret("b"),
  METRICS_TOKEN: secret("c"),
};

function problemsOf(input: Record<string, string>): string[] {
  const result = parseRealtimeEnv(input);
  return result.ok ? [] : result.problems;
}

describe("Realtime-Env", () => {
  it("akzeptiert die Ausgabe von realtimeProcessEnv() (dev und prod)", () => {
    const devSource = sourceEnvSchema.parse({
      MONGODB_URI: "mongodb://127.0.0.1:27017/?replicaSet=rs0",
      MONGODB_DB: "quizmaster_dev",
      SESSION_SECRET: secret("s"),
      REALTIME_TICKET_SECRET: secret("a"),
      IP_HASH_SECRET: secret("b"),
      METRICS_TOKEN: secret("c"),
    });
    const dev = parseRealtimeEnv(realtimeProcessEnv(resolveEnv(devSource, "dev")));
    expect(dev.ok).toBe(true);
    if (dev.ok) {
      expect(dev.env).toMatchObject({
        HOST: "127.0.0.1",
        REALTIME_PORT: 3001,
        APP_ORIGIN: ["http://localhost:3000"],
        GAME_TIMING: "normal",
        QUESTION_POOL: "all",
        MAX_CONNECTIONS: 20_000,
        DEV_BOTS_ENABLED: false,
        LOG_LEVEL: "info",
        RATE_LIMIT_MODE: "normal",
        databaseKind: "development",
      });
    }

    const prodSource = sourceEnvSchema.parse({
      QUIZMASTER_DOMAIN: "quiz.example.com",
      QUIZMASTER_PORT: "7400",
      MONGODB_URI: "mongodb+srv://user:pw@cluster.example.net/",
      MONGODB_DB: "quizmaster",
      SESSION_SECRET: secret("s"),
      REALTIME_TICKET_SECRET: secret("a"),
      IP_HASH_SECRET: secret("b"),
      METRICS_TOKEN: secret("c"),
      TRUSTED_IP_HEADER: "cf-connecting-ip",
    });
    const prod = parseRealtimeEnv(realtimeProcessEnv(resolveEnv(prodSource, "prod")));
    expect(prod.ok).toBe(true);
    if (prod.ok) {
      expect(prod.env).toMatchObject({
        REALTIME_PORT: 7401,
        APP_ORIGIN: ["https://quiz.example.com"],
        TRUSTED_IP_HEADER: "cf-connecting-ip",
        databaseKind: "production",
      });
    }
  });

  it("nennt fehlende und ungültige Schlüssel – nie Werte", () => {
    const problems = problemsOf({ ...minimal, MONGODB_URI: "", METRICS_TOKEN: "kurz", APP_ORIGIN: "ftp://x" });
    expect(problems).toContain("MONGODB_URI: fehlt");
    expect(problems.some((problem) => problem.startsWith("METRICS_TOKEN:"))).toBe(true);
    expect(problems.some((problem) => problem.startsWith("APP_ORIGIN:"))).toBe(true);
    expect(problems.join("\n")).not.toContain("kurz");
    expect(problemsOf({})).toEqual(
      expect.arrayContaining(["REALTIME_PORT: fehlt", "APP_ORIGIN: fehlt", "REALTIME_TICKET_SECRET: fehlt"]),
    );
  });

  it("RATE_LIMIT_MODE=relaxed und Collection-Präfix nur mit *_test-Datenbank", () => {
    expect(problemsOf({ ...minimal, RATE_LIMIT_MODE: "relaxed" })).toEqual([
      "RATE_LIMIT_MODE: relaxed ist nur mit einer *_test-Datenbank erlaubt",
    ]);
    expect(problemsOf({ ...minimal, MONGODB_COLLECTION_PREFIX: "t1_" })).toEqual([
      "MONGODB_COLLECTION_PREFIX: nur für *_test-Datenbanken erlaubt",
    ]);
    const test = parseRealtimeEnv({
      ...minimal,
      MONGODB_DB: "quizmaster_test",
      RATE_LIMIT_MODE: "relaxed",
      MONGODB_COLLECTION_PREFIX: "t1_",
    });
    expect(test.ok && test.env.RATE_LIMIT_MODE).toBe("relaxed");
    expect(problemsOf({ ...minimal, RATE_LIMIT_MODE: "off" }).some((p) => p.startsWith("RATE_LIMIT_MODE:"))).toBe(true);
  });

  it("Secrets müssen je Zweck verschieden sein", () => {
    expect(problemsOf({ ...minimal, METRICS_TOKEN: minimal.IP_HASH_SECRET ?? "" })).toHaveLength(1);
  });

  it("Produktions-Datenbank: keine Dev-Bots, kein fast-Timing, nur https-Origins", () => {
    const prod = { ...minimal, MONGODB_DB: "quizmaster", APP_ORIGIN: "https://quiz.example.com" };
    expect(problemsOf(prod)).toEqual([]);
    expect(problemsOf({ ...prod, DEV_BOTS_ENABLED: "true" })).toEqual([
      "DEV_BOTS_ENABLED: muss in Produktion false sein",
    ]);
    expect(problemsOf({ ...prod, GAME_TIMING: "fast" })).toEqual(["GAME_TIMING: muss in Produktion normal sein"]);
    expect(problemsOf({ ...prod, APP_ORIGIN: "http://quiz.example.com" })).toEqual([
      "APP_ORIGIN: muss in Produktion https:// verwenden",
    ]);
  });

  it("HOST nur als IP oder localhost; Ports im erlaubten Bereich", () => {
    expect(problemsOf({ ...minimal, HOST: "0.0.0.0" })).toEqual([]);
    expect(problemsOf({ ...minimal, HOST: "evil host" }).some((p) => p.startsWith("HOST:"))).toBe(true);
    expect(problemsOf({ ...minimal, REALTIME_PORT: "80" }).some((p) => p.startsWith("REALTIME_PORT:"))).toBe(true);
  });

  it("databaseKindOf", () => {
    expect(databaseKindOf("quizmaster_test")).toBe("test");
    expect(databaseKindOf("quizmaster_dev")).toBe("development");
    expect(databaseKindOf("quizmaster")).toBe("production");
    expect(databaseKindOf("quizmaster_staging")).toBe("production");
  });
});
