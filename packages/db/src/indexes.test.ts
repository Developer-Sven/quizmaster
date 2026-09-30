import { APP_CONFIG_ID } from "@quizmaster/shared/documents";
import { MongoServerError } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { collectionName } from "./collections.ts";
import { ensureIndexes, ensureQuestionsValidator, INDEX_DEFINITIONS } from "./indexes.ts";
import type { DbLogger } from "./logger.ts";
import { planStages, sampleQuestion } from "./test-support.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";
import { QUESTIONS_VALIDATOR } from "./validators.ts";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.cleanup();
});

function recordingLogger(): DbLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, info: () => undefined, warn: (message) => warnings.push(message), error: () => undefined };
}

describe("ensureIndexes()", () => {
  it("legt alle Indizes aus docs/04 an und ist idempotent", async () => {
    const first = await ensureIndexes(t.db, { prefix: t.prefix });
    expect(first.questionsValidator).toBe("created");
    expect(first.appConfigCreated).toBe(true);
    const second = await ensureIndexes(t.db, { prefix: t.prefix });
    expect(second.questionsValidator).toBe("unchanged");
    expect(second.appConfigCreated).toBe(false);

    for (const definition of INDEX_DEFINITIONS) {
      const indexes = await t.db.collection(collectionName(definition.collection, t.prefix)).indexes();
      const found = indexes.find((index) => index.name === definition.name);
      expect(found, `${definition.collection}.${definition.name}`).toBeDefined();
      expect(found?.key).toEqual(definition.key);
    }
  });

  it("setzt TTL, partiellen Unique-Index für Lobby-Codes und Unique für Bans", async () => {
    const lobbies = await t.collections.lobbies.indexes();
    const code = lobbies.find((index) => index.name === "code_active_unique");
    expect(code?.unique).toBe(true);
    expect(code?.partialFilterExpression).toEqual({ active: true });
    const ttl = lobbies.find((index) => index.name === "expiresAt_ttl");
    expect(ttl?.expireAfterSeconds).toBe(0);
    const bans = await t.collections.bans.indexes();
    expect(bans.find((index) => index.name === "kind_value_unique")?.unique).toBe(true);
    const events = await t.collections.socketioEvents.indexes();
    expect(events.find((index) => index.name === "createdAt_ttl")?.expireAfterSeconds).toBe(3_600);
  });

  it("legt appConfig mit Startwerten per $setOnInsert an und überschreibt nichts", async () => {
    const config = await t.collections.appConfig.findOne({ _id: APP_CONFIG_ID });
    expect(config).toMatchObject({
      maintenance: { enabled: false, message: null },
      lobbyCreationEnabled: true,
      turnstileOnJoin: false,
      maxActiveLobbies: 5_000,
      minClientProtocol: 1,
      blockedTerms: [],
    });
    expect(config?.catalog?.minPlayable).toBeGreaterThan(0);
    await t.collections.appConfig.updateOne({ _id: APP_CONFIG_ID }, { $set: { turnstileOnJoin: true } });
    await ensureIndexes(t.db, { prefix: t.prefix });
    expect((await t.collections.appConfig.findOne({ _id: APP_CONFIG_ID }))?.turnstileOnJoin).toBe(true);
  });

  it("$jsonSchema-Validator weist kaputte Fragen ab und lässt gültige zu", async () => {
    await t.collections.questions.insertOne(sampleQuestion("co-valid001"));
    const broken = { ...sampleQuestion("co-broken01"), answers: ["nur", "drei", "Antworten"] };
    await expect(
      t.collections.questions.insertOne(broken as unknown as ReturnType<typeof sampleQuestion>),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      t.collections.questions.insertOne({ ...sampleQuestion("co-broken02"), difficulty: 7 as 1 }),
    ).rejects.toMatchObject({ code: 121 });
  });

  it("aktualisiert einen abweichenden Validator per collMod", async () => {
    const name = collectionName("questions", t.prefix);
    await t.db.command({ collMod: name, validator: { $jsonSchema: { bsonType: "object" } } });
    expect(await ensureQuestionsValidator(t.db, { prefix: t.prefix })).toBe("updated");
    const [info] = await t.db.listCollections({ name }).toArray();
    expect((info as { options?: { validator?: unknown } }).options?.validator).toEqual(QUESTIONS_VALIDATOR);
  });

  it("warnt klar und bricht nicht ab, wenn das Recht für collMod fehlt (Mock)", async () => {
    const name = collectionName("questions", t.prefix);
    await t.db.command({ collMod: name, validator: { $jsonSchema: { bsonType: "object" } } });
    const original = t.db.command.bind(t.db);
    const spy = vi.spyOn(t.db, "command").mockImplementation(async (command, options) => {
      if ("collMod" in command) {
        throw new MongoServerError({ ok: 0, code: 13, codeName: "Unauthorized", errmsg: "not authorized to collMod" });
      }
      return original(command, options);
    });
    try {
      const logger = recordingLogger();
      const result = await ensureIndexes(t.db, { prefix: t.prefix, logger });
      expect(result.questionsValidator).toBe("skipped_unauthorized");
      expect(logger.warnings.join("\n")).toMatch(/Validator .* NICHT gesetzt .*collMod/);
    } finally {
      spy.mockRestore();
    }
    expect(await ensureQuestionsValidator(t.db, { prefix: t.prefix })).toBe("updated");
  });
});

describe("ensureIndexes() – Konflikte", () => {
  it("bricht bei gleichnamigem Index mit anderer Definition mit klarer Meldung ab", async () => {
    const other = await createTestDatabase();
    try {
      await other.collections.questions.createIndex({ updatedAt: -1 }, { name: "updatedAt" });
      await expect(ensureIndexes(other.db, { prefix: other.prefix })).rejects.toThrow(/Index-Konflikt/);
    } finally {
      await other.cleanup();
    }
  });
});

describe("Indizes tragen die Hot-Path-Abfragen (explain)", () => {
  it("Pool laden → IXSCAN status_category_difficulty", async () => {
    const plan = await t.collections.questions
      .find(
        { status: { $in: ["unverified", "approved"] } },
        { projection: { _id: 1, category: 1, topic: 1, difficulty: 1 } },
      )
      .explain("queryPlanner");
    const stages = planStages(plan);
    expect(stages.stages).toContain("IXSCAN");
    expect(stages.stages).not.toContain("COLLSCAN");
    expect(stages.indexNames).toContain("status_category_difficulty");
  });

  it("Prüf-Queue → IXSCAN status_createdAt ohne SORT-Stufe", async () => {
    const plan = await t.collections.questionReports
      .find({ status: "open" })
      .sort({ createdAt: -1 })
      .limit(50)
      .explain("queryPlanner");
    const stages = planStages(plan);
    expect(stages.indexNames).toContain("status_createdAt");
    expect(stages.stages).not.toContain("COLLSCAN");
    expect(stages.stages).not.toContain("SORT");
  });

  it("Code-Lookup aktiver Lobbys → partieller Unique-Index", async () => {
    const plan = await t.collections.lobbies.find({ code: "ABC234", active: true }).explain("queryPlanner");
    const stages = planStages(plan);
    expect(stages.indexNames).toContain("code_active_unique");
    expect(stages.stages).not.toContain("COLLSCAN");
  });

  it("Bans je Schlüssel → Unique-Index kind_value", async () => {
    const plan = await t.collections.bans.find({ kind: "guest", value: "x" }).explain("queryPlanner");
    expect(planStages(plan).indexNames).toContain("kind_value_unique");
  });
});
