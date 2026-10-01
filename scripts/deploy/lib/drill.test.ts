import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { DRILL_DOMAIN, drillEnv } from "./drill.ts";
import { serializeEnv } from "./envfiles.ts";

const URI = "mongodb://drill:p%23ss@db.example.com:27017/?tls=true&authSource=admin";
const base = { uri: URI, dbName: "quizmaster_test", prefix: "t2610010830_ab12cd_", webPort: 7490, realtimePort: 7491 };
let counter = 0;
const random = (size: number) => Buffer.alloc(size, ++counter);

describe("drillEnv", () => {
  it("Test-Ports, *_test-Datenbank mit Präfix, vier verschiedene Secrets, Turnstile und Bots aus", () => {
    const env = drillEnv({ ...base, random });
    expect(env).toMatchObject({
      QUIZMASTER_DOMAIN: DRILL_DOMAIN,
      QUIZMASTER_PORT: "7490",
      REALTIME_PORT: "7491",
      MONGODB_DB: "quizmaster_test",
      MONGODB_COLLECTION_PREFIX: "t2610010830_ab12cd_",
      TURNSTILE_ENABLED: "false",
      DEV_BOTS_ENABLED: "false",
      SEARCH_INDEXING: "false",
    });
    const secrets = [env.SESSION_SECRET, env.REALTIME_TICKET_SECRET, env.IP_HASH_SECRET, env.METRICS_TOKEN];
    expect(new Set(secrets).size).toBe(4);
    for (const value of secrets) expect(value?.length).toBeGreaterThanOrEqual(43);
    // Die Datei liest der Deploy (und Node per --env-file) exakt so zurück.
    expect(parseEnv(serializeEnv(env))).toEqual(env);
  });

  it("verweigert Datenbanken außerhalb von *_test, fremde Präfixe und gleiche Ports – ohne Werte zu nennen", () => {
    expect(() => drillEnv({ ...base, dbName: "quizmaster_dev" })).toThrow(/TEST_DB/);
    expect(() => drillEnv({ ...base, dbName: "quizmaster" })).toThrow(/PREFIX_OUTSIDE_TEST_DB/);
    expect(() => drillEnv({ ...base, prefix: "eigen_" })).toThrow(/TEST_PREFIX/);
    expect(() => drillEnv({ ...base, realtimePort: 7490 })).toThrow(/PORT_CONFLICT/);
    try {
      drillEnv({ ...base, uri: "postgres://geheim@host/db" });
    } catch (error) {
      expect(String(error)).toContain("MONGODB_URI");
      expect(String(error)).not.toContain("geheim");
    }
  });
});
