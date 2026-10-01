import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger";
import { createWebRateLimiters, RELAXED_RATE_LIMIT_FACTOR } from "./rate-limit";

let unreachable: MongoClient;
// rate-limiter-flexible meldet das fehlgeschlagene Anlegen der Indizes (DB weg) über console.error.
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

beforeAll(() => {
  unreachable = new MongoClient("mongodb://127.0.0.1:9/?directConnection=true", {
    serverSelectionTimeoutMS: 200,
    connectTimeoutMS: 200,
  });
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  consoleError.mockRestore();
  await unreachable.close();
});

const logger = createLogger({ level: "silent" });

describe("Web-Rate-Limits", () => {
  it("Mongo-Store nicht erreichbar → Memory-insuranceLimiter zählt weiter (10 / 10 min je IP)", async () => {
    const limiters = createWebRateLimiters({ db: unreachable.db("quizmaster_test"), mode: "normal", logger });
    for (let i = 0; i < 10; i++) {
      expect(await limiters.consume("POST /api/session", "ip", "ip-a")).toEqual({ ok: true });
    }
    const limited = await limiters.consume("POST /api/session", "ip", "ip-a");
    expect(limited).toMatchObject({ ok: false, reason: "limited" });
    expect(limited.ok === false && limited.reason === "limited" && limited.retryAfterMs).toBeGreaterThan(0);
    expect(await limiters.consume("POST /api/session", "ip", "ip-b")).toEqual({ ok: true });
  }, 30_000);

  it("Memory-Limits nach Tabelle; relaxed multipliziert mit 100", async () => {
    const db = unreachable.db("quizmaster_test");
    const normal = createWebRateLimiters({ db, mode: "normal", logger });
    const relaxed = createWebRateLimiters({ db, mode: "relaxed", logger });
    for (let i = 0; i < 60; i++) await normal.consume("GET /api/health", "ip", "k");
    expect((await normal.consume("GET /api/health", "ip", "k")).ok).toBe(false);
    for (let i = 0; i < 60 * RELAXED_RATE_LIMIT_FACTOR; i++) await relaxed.consume("GET /api/health", "ip", "k");
    expect((await relaxed.consume("GET /api/health", "ip", "k")).ok).toBe(false);
  });

  it("wirft bei Endpunkt/Bereich ohne Regel (Programmierfehler statt stiller Freigabe)", async () => {
    const limiters = createWebRateLimiters({ db: unreachable.db("quizmaster_test"), mode: "normal", logger });
    await expect(limiters.consume("GET /api/health", "guest", "x")).rejects.toThrow(/Kein Rate-Limit/);
  });
});
