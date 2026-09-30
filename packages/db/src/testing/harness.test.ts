import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCollections } from "../collections.ts";
import {
  cleanupStalePrefixes,
  createTestDatabase,
  createTestPrefix,
  dropPrefixCollections,
  STALE_PREFIX_AGE_MS,
  TEST_PREFIX_REGEX,
  type TestDatabase,
  testPrefixCreatedAt,
  testPrefixOf,
} from "./index.ts";

describe("Test-Präfixe", () => {
  it("haben Zeitstempel (UTC) und Zufallsteil", () => {
    const now = new Date("2026-09-30T18:12:00Z");
    const prefix = createTestPrefix(now, () => 0);
    expect(prefix).toBe("t2609301812_aaaaaa_");
    expect(TEST_PREFIX_REGEX.test(prefix)).toBe(true);
    expect(testPrefixCreatedAt(prefix)?.toISOString()).toBe("2026-09-30T18:12:00.000Z");
    expect(testPrefixOf(`${prefix}questions`)).toBe(prefix);
    expect(testPrefixOf("questions")).toBeNull();
    expect(createTestPrefix()).toMatch(/^t\d{10}_[a-z0-9]{6}_$/);
  });
});

describe("Harness (Präfix-Isolation)", () => {
  let first: TestDatabase;
  let second: TestDatabase;

  beforeAll(async () => {
    [first, second] = await Promise.all([createTestDatabase(), createTestDatabase()]);
  });

  afterAll(async () => {
    await Promise.all([first?.cleanup(), second?.cleanup()]);
  });

  it("nutzt eine *_test-Datenbank und je Instanz ein eigenes Präfix", () => {
    expect(first.dbName.endsWith("_test")).toBe(true);
    expect(first.db.databaseName).toBe(first.dbName);
    expect(first.prefix).not.toBe(second.prefix);
    expect(first.collections.questions.collectionName).toBe(`${first.prefix}questions`);
  });

  it("trennt Daten gleichnamiger Collections", async () => {
    await first.collections.bans.insertOne({
      _id: "ban-a",
      kind: "guest",
      value: "a",
      reason: "Test",
      createdAt: new Date(),
    });
    expect(await first.collections.bans.countDocuments()).toBe(1);
    expect(await second.collections.bans.countDocuments()).toBe(0);
  });

  it("cleanup() eines Präfixes lässt andere Präfixe unberührt", async () => {
    const third = await createTestDatabase();
    await third.collections.bans.insertOne({
      _id: "ban-c",
      kind: "ip",
      value: "c",
      reason: "Test",
      createdAt: new Date(),
    });
    await third.cleanup();
    await third.cleanup(); // idempotent
    const names = (await first.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    expect(names.some((name) => name.startsWith(third.prefix))).toBe(false);
    expect(names).toContain(`${first.prefix}bans`);
    expect(await first.collections.bans.countDocuments()).toBe(1);
  });

  it("verbietet Präfixe außerhalb von *_test-Datenbanken (ADR-029)", () => {
    const devDb = first.client.db("quizmaster_dev");
    expect(() => getCollections(devDb, { prefix: first.prefix })).toThrow(/_test/);
    expect(() => getCollections(first.db, { prefix: "Böse Präfix" })).toThrow(/Ungültiger/);
  });

  it("Janitor entfernt nur verwaiste Präfixe (älter als 6 h)", async () => {
    const old = createTestPrefix(new Date(Date.now() - STALE_PREFIX_AGE_MS - 60 * 60_000));
    await first.db.collection(`${old}questions`).insertOne({ marker: true });
    const result = await cleanupStalePrefixes(first.db);
    expect(result.prefixes).toContain(old);
    const names = (await first.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    expect(names).not.toContain(`${old}questions`);
    expect(names).toContain(`${first.prefix}bans`);
  });

  it("dropPrefixCollections verweigert fremde Namen und Nicht-Test-Datenbanken", async () => {
    await expect(dropPrefixCollections(first.db, "questions")).rejects.toThrow(/Kein Test-Präfix/);
    await expect(dropPrefixCollections(first.client.db("quizmaster_dev"), first.prefix)).rejects.toThrow(/_test/);
  });
});
