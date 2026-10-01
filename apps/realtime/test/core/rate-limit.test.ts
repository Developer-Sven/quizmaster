/**
 * Rate-Limit-Dienst: Memory-Regeln, relaxed-Faktor, Fehlversuchs-Regeln mit Sperre, Mongo-Store (Collection
 * `rateLimits` der Test-DB) und die Memory-Versicherung bei Store-Ausfall oder -Zeitüberschreitung.
 */

import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { RATE_LIMITS } from "@quizmaster/shared";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRateLimitService, effectiveRule } from "../../src/services/rate-limit.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

describe("Rate-Limits im Speicher", () => {
  it("time:sync: 10 erlaubt, dann gesperrt mit retryAfterMs ≤ Fenster", async () => {
    const limits = createRateLimitService({ mode: "normal" });
    const [rule] = limits.rulesFor("time:sync");
    if (rule === undefined) throw new Error("Regel fehlt");
    for (let i = 1; i <= 10; i++) {
      const decision = await limits.consume(rule, "socket-1");
      expect(decision).toMatchObject({ allowed: true, consumedPoints: i, remainingPoints: 10 - i, degraded: false });
    }
    const blocked = await limits.consume(rule, "socket-1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(10_000);
    expect((await limits.consume(rule, "socket-2")).allowed).toBe(true);
    await limits.reset(rule, "socket-1");
    expect((await limits.consume(rule, "socket-1")).allowed).toBe(true);
  });

  it("relaxed multipliziert Zeitfenster-Limits mit 100, lässt „once“-Regeln unverändert", () => {
    const relaxed = createRateLimitService({ mode: "relaxed" });
    for (const rule of RATE_LIMITS) {
      const effective = relaxed.rule(rule.id);
      expect(effective.points).toBe(rule.kind === "rate" ? rule.points * 100 : rule.points);
      expect(effectiveRule(rule, "normal")).toBe(rule);
    }
  });

  it("unbekannte Regeln und „once“-Regeln haben keinen Limiter", async () => {
    const limits = createRateLimitService({ mode: "normal" });
    expect(() => limits.rule("gibt-es-nicht")).toThrow(/Unbekannte/);
    await expect(limits.consume(limits.rule("event.game-answer.once"), "k")).rejects.toThrow(/kein Zeitfenster-Limit/);
  });

  it("Fehlversuchs-Regel: peek verbraucht nichts; Überschreitung sperrt für blockDuration", async () => {
    const limits = createRateLimitService({ mode: "normal" });
    const rule = limits.rule("event.lobby-join.failed.ip");
    expect((await limits.peek(rule, "ip")).allowed).toBe(true);
    for (let i = 0; i < rule.points; i++) expect((await limits.consume(rule, "ip")).allowed).toBe(true);
    expect((await limits.peek(rule, "ip")).allowed).toBe(true);
    const exceeded = await limits.consume(rule, "ip");
    expect(exceeded.allowed).toBe(false);
    const blocked = await limits.peek(rule, "ip");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan((rule.blockDurationSec - 5) * 1_000);
  });
});

describe("Rate-Limits im Mongo-Store", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase({ ensureIndexes: true });
  });
  afterAll(() => database?.cleanup());

  const storeOf = (client: MongoClient) => ({
    client,
    dbName: database.dbName,
    collection: database.collections.rateLimits,
  });

  it("zählt in der Collection rateLimits (TTL-Index) und sperrt nach 5 Lobby-Erstellungen je Minute", async () => {
    const onStoreError = vi.fn();
    const limits = createRateLimitService({ mode: "normal", store: storeOf(database.client), onStoreError });
    await limits.ensureStore();
    await limits.ensureStore();
    const rule = limits.rule("event.lobby-create.guest.minute");
    expect(rule.points).toBe(5);
    for (let i = 0; i < rule.points; i++)
      expect(await limits.consume(rule, "guest-1")).toMatchObject({ allowed: true, degraded: false });
    const blocked = await limits.consume(rule, "guest-1");
    expect(blocked).toMatchObject({ allowed: false, degraded: false });
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(onStoreError).not.toHaveBeenCalled();

    const doc = await database.collections.rateLimits.findOne({ key: "qm:event.lobby-create.guest.minute:guest-1" });
    expect(doc?.points).toBe(rule.points + 1);
    const indexes = await database.collections.rateLimits.indexes();
    expect(indexes.some((index) => index.key.expire === -1 && index.expireAfterSeconds === 0)).toBe(true);
    expect(indexes.some((index) => index.key.key === 1 && index.unique === true)).toBe(true);

    // Eine zweite Instanz (anderer Prozess) sieht denselben Zähler.
    const other = createRateLimitService({ mode: "normal", store: storeOf(database.client) });
    expect((await other.consume(other.rule(rule.id), "guest-1")).allowed).toBe(false);
    expect((await other.peek(other.rule(rule.id), "guest-1")).allowed).toBe(false);
  });

  it("Store-Ausfall → Memory-Versicherung entscheidet (degraded) und meldet den Fehler", async () => {
    const broken = new MongoClient("mongodb://127.0.0.1:1/?directConnection=true", {
      serverSelectionTimeoutMS: 100,
      connectTimeoutMS: 100,
    });
    try {
      const onStoreError = vi.fn();
      const limits = createRateLimitService({ mode: "normal", store: storeOf(broken), onStoreError });
      const rule = limits.rule("event.lobby-create.guest.minute");
      for (let i = 0; i < rule.points; i++)
        expect(await limits.consume(rule, "g")).toMatchObject({ allowed: true, degraded: true });
      expect(await limits.consume(rule, "g")).toMatchObject({ allowed: false, degraded: true });
      expect((await limits.peek(rule, "g")).degraded).toBe(true);
      expect(onStoreError).toHaveBeenCalled();
      expect(onStoreError.mock.calls[0]?.[0]).toMatchObject({ id: rule.id });
    } finally {
      await broken.close();
    }
  });

  it("Store-Zeitüberschreitung → Versicherung nach storeTimeoutMs", async () => {
    const slow = new MongoClient("mongodb://127.0.0.1:1/?directConnection=true", {
      serverSelectionTimeoutMS: 5_000,
    });
    try {
      const onStoreError = vi.fn();
      const limits = createRateLimitService({ mode: "normal", store: storeOf(slow), onStoreError, storeTimeoutMs: 50 });
      const started = performance.now();
      const decision = await limits.consume(limits.rule("guest.violation-disconnects"), "g");
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(decision).toMatchObject({ allowed: true, degraded: true });
      expect(String(onStoreError.mock.calls[0]?.[1])).toMatch(/50 ms/);
    } finally {
      await slow.close();
    }
  });
});
