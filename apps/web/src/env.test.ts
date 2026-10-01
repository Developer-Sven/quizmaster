import { afterEach, describe, expect, it, vi } from "vitest";
import { clearWebEnvCache, getWebEnv, parseWebEnv, WEB_ENV_KEYS, WebEnvError } from "./env";
import { TEST_SECRETS, testEnvSource } from "./lib/server/test-support";

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof WebEnvError) return [...error.problems];
    throw error;
  }
  return [];
}

describe("parseWebEnv", () => {
  it("liefert aufbereitete Werte mit sicheren Standards", () => {
    const env = parseWebEnv(testEnvSource({ NODE_ENV: undefined, LOG_LEVEL: undefined }));
    expect(env.nodeEnv).toBe("production");
    expect(env.appOrigin).toBe("http://localhost:3120");
    expect(env.httpsOrigin).toBe(false);
    expect(env.realtimeUrl).toBe("http://localhost:3121");
    expect(env.turnstile).toEqual({ enabled: false, siteKey: undefined, secretKey: undefined });
    expect(env.searchIndexing).toBe(false);
    expect(env.logLevel).toBe("info");
    expect(env.rateLimitMode).toBe("normal");
    expect(env.devBots).toBe(false);
  });

  it("übernimmt mehrere Origins kanonisch, die erste ist die öffentliche; leere REALTIME_URL = gleiche Origin", () => {
    const env = parseWebEnv(
      testEnvSource({ APP_ORIGIN: " https://Quiz.Example.com:443 , http://localhost:3000", REALTIME_URL: "" }),
    );
    expect(env.appOrigins).toEqual(["https://quiz.example.com", "http://localhost:3000"]);
    expect(env.appOrigin).toBe("https://quiz.example.com");
    expect(env.httpsOrigin).toBe(true);
    expect(env.realtimeUrl).toBe("");
  });

  it("verlangt die Pflichtschlüssel und nennt nur Schlüssel, nie Werte", () => {
    const problems = problemsOf(() => parseWebEnv({}));
    const keys = problems.map((problem) => problem.split(":")[0]);
    expect(keys).toEqual(
      expect.arrayContaining([
        "APP_ORIGIN",
        "MONGODB_URI",
        "MONGODB_DB",
        "SESSION_SECRET",
        "REALTIME_TICKET_SECRET",
        "IP_HASH_SECRET",
      ]),
    );
    const secretProblems = problemsOf(() =>
      parseWebEnv(testEnvSource({ SESSION_SECRET: "zu-kurz-und-geheim", MONGODB_URI: "postgres://user:pw@h/x" })),
    );
    expect(secretProblems.join(" ")).not.toContain("zu-kurz-und-geheim");
    expect(secretProblems.join(" ")).not.toContain("user:pw");
  });

  it("lehnt Origins mit Pfad ab", () => {
    expect(problemsOf(() => parseWebEnv(testEnvSource({ APP_ORIGIN: "https://quiz.example.com/app" })))).toHaveLength(
      1,
    );
    expect(problemsOf(() => parseWebEnv(testEnvSource({ REALTIME_URL: "ws://rt.example.com" })))).toHaveLength(1);
  });

  it("erlaubt Collection-Präfix und RATE_LIMIT_MODE=relaxed nur mit *_test-Datenbank", () => {
    const dev = { MONGODB_DB: "quizmaster_dev" };
    expect(problemsOf(() => parseWebEnv(testEnvSource({ ...dev, MONGODB_COLLECTION_PREFIX: "t_x_" })))).toEqual([
      expect.stringMatching(/^MONGODB_COLLECTION_PREFIX:/),
    ]);
    expect(problemsOf(() => parseWebEnv(testEnvSource({ ...dev, RATE_LIMIT_MODE: "relaxed" })))).toEqual([
      expect.stringMatching(/^RATE_LIMIT_MODE:/),
    ]);
    expect(
      problemsOf(() => parseWebEnv(testEnvSource({ MONGODB_DB: "quizmaster", RATE_LIMIT_MODE: "relaxed" }))),
    ).toEqual([expect.stringMatching(/^RATE_LIMIT_MODE:/)]);
    const test = parseWebEnv(testEnvSource({ MONGODB_COLLECTION_PREFIX: "t_x_", RATE_LIMIT_MODE: "relaxed" }));
    expect(test.collectionPrefix).toBe("t_x_");
    expect(test.rateLimitMode).toBe("relaxed");
  });

  it("verlangt verschiedene Secrets und bei TURNSTILE_ENABLED beide Schlüssel", () => {
    expect(
      problemsOf(() => parseWebEnv(testEnvSource({ IP_HASH_SECRET: TEST_SECRETS.SESSION_SECRET }))).join(" "),
    ).toMatch(/verschieden/);
    expect(problemsOf(() => parseWebEnv(testEnvSource({ TURNSTILE_ENABLED: "true" })))).toEqual([
      expect.stringMatching(/^TURNSTILE_ENABLED:/),
    ]);
    expect(problemsOf(() => parseWebEnv(testEnvSource({ TURNSTILE_ENABLED: "yes" })))).toHaveLength(1);
  });

  it("liest DEV_BOTS_ENABLED (Standard aus) – an nur mit *_dev- oder *_test-Datenbank", () => {
    expect(parseWebEnv(testEnvSource()).devBots).toBe(false);
    expect(parseWebEnv(testEnvSource({ DEV_BOTS_ENABLED: "true" })).devBots).toBe(true);
    expect(parseWebEnv(testEnvSource({ DEV_BOTS_ENABLED: "true", MONGODB_DB: "quizmaster_dev" })).devBots).toBe(true);
    expect(parseWebEnv(testEnvSource({ DEV_BOTS_ENABLED: "false", MONGODB_DB: "quizmaster" })).devBots).toBe(false);
    expect(
      problemsOf(() => parseWebEnv(testEnvSource({ DEV_BOTS_ENABLED: "true", MONGODB_DB: "quizmaster" }))),
    ).toEqual([expect.stringMatching(/^DEV_BOTS_ENABLED:/)]);
    expect(problemsOf(() => parseWebEnv(testEnvSource({ DEV_BOTS_ENABLED: "ja" })))).toEqual([
      expect.stringMatching(/^DEV_BOTS_ENABLED:/),
    ]);
  });

  it("lehnt Cloudflare-Turnstile-Testschlüssel außerhalb von *_dev/*_test ab (Bot-Schutz sonst wirkungslos)", () => {
    const testKeys = { TURNSTILE_SITE_KEY: "1x00000000000000000000AA" };
    for (const secret of [
      "1x0000000000000000000000000000000AA",
      "2x0000000000000000000000000000000AA",
      "3x0000000000000000000000000000000AA",
    ]) {
      const problems = problemsOf(() =>
        parseWebEnv(testEnvSource({ ...testKeys, TURNSTILE_SECRET_KEY: secret, MONGODB_DB: "quizmaster" })),
      );
      expect(problems).toEqual([expect.stringMatching(/^TURNSTILE_SECRET_KEY:.*Testschlüssel/)]);
      expect(problems.join(" ")).not.toContain(secret);
      for (const db of ["quizmaster_dev", "quizmaster_test"]) {
        expect(
          parseWebEnv(testEnvSource({ ...testKeys, TURNSTILE_SECRET_KEY: secret, MONGODB_DB: db })).turnstile.secretKey,
        ).toBe(secret);
      }
    }
    const real = parseWebEnv(
      testEnvSource({ ...testKeys, TURNSTILE_SECRET_KEY: "0x4AAAAAAAecht-und-geheim", MONGODB_DB: "quizmaster" }),
    );
    expect(real.turnstile.secretKey).toBe("0x4AAAAAAAecht-und-geheim");
  });
});

describe("Lazy-Verhalten (Build ohne Env)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearWebEnvCache();
  });

  const clearEnv = () => {
    for (const key of WEB_ENV_KEYS) vi.stubEnv(key, undefined);
  };

  it("Import von env, Proxy, Instrumentation und allen API-Routen liest keine Env", async () => {
    clearEnv();
    clearWebEnvCache();
    await expect(import("./env")).resolves.toBeDefined();
    await expect(import("./proxy")).resolves.toBeDefined();
    await expect(import("./instrumentation")).resolves.toBeDefined();
    await expect(import("./app/api/session/route")).resolves.toBeDefined();
    await expect(import("./app/api/realtime/ticket/route")).resolves.toBeDefined();
    await expect(import("./app/api/categories/route")).resolves.toBeDefined();
    await expect(import("./app/api/health/route")).resolves.toBeDefined();
    await expect(import("./lib/server/runtime-config")).resolves.toBeDefined();
  });

  it("parst erst beim ersten Zugriff, wirft ohne Env WebEnvError und cacht nur Erfolge", () => {
    clearEnv();
    expect(() => getWebEnv()).toThrow(WebEnvError);
    for (const [key, value] of Object.entries(testEnvSource())) vi.stubEnv(key, value);
    const first = getWebEnv();
    expect(first.appOrigin).toBe("http://localhost:3120");
    vi.stubEnv("APP_ORIGIN", "https://anders.example.com");
    expect(getWebEnv()).toBe(first);
    clearWebEnvCache();
    expect(getWebEnv().appOrigin).toBe("https://anders.example.com");
  });
});
