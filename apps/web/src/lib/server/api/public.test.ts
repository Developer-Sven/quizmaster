import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { categoriesResponseSchema } from "@quizmaster/shared";
import type { CategoryDoc } from "@quizmaster/shared/documents";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServerContext, type ServerContext } from "../context";
import { createHealthProbe } from "../health";
import { createLogger } from "../logger";
import { testEnv, testRequest } from "../test-support";
import { CATEGORIES_CACHE_CONTROL, handleCategoriesRequest, handleHealthRequest, healthUnavailable } from "./public";
import { runApi } from "./route";

let t: TestDatabase;
let unreachable: MongoClient;

function category(id: string, order: number, playable: boolean): CategoryDoc {
  return {
    _id: id,
    name: `Kategorie ${order}`,
    icon: "book-open",
    color: "#3366FF",
    order,
    description: "Beschreibung",
    scope: "GEHEIM-scope",
    notScope: "GEHEIM-notScope",
    active: true,
    playableCount: playable ? 500 : 3,
    approvedCount: 0,
    playable,
    topics: [{ id: "geheim-thema", name: "Geheimes Thema", target: 50, method: "ki" }],
    updatedAt: new Date(),
  };
}

beforeAll(async () => {
  t = await createTestDatabase({ ensureIndexes: true });
  await t.collections.categories.insertMany([
    category("zweite", 2, true),
    category("erste", 1, true),
    category("nicht-spielbar", 3, false),
    // Verletzt den öffentlichen Vertrag (Farbe) → wird ausgelassen statt die ganze Liste zu kippen.
    { ...category("kaputt", 4, true), color: "rot" },
  ]);
  // Port 9 (discard) ist lokal geschlossen → Verbindungsfehler in Millisekunden.
  unreachable = new MongoClient("mongodb://127.0.0.1:9/?directConnection=true", {
    serverSelectionTimeoutMS: 300,
    connectTimeoutMS: 300,
  });
}, 60_000);

afterAll(async () => {
  await unreachable?.close();
  await t?.cleanup();
});

function context(client: MongoClient = t.client): ServerContext {
  const env = testEnv({ MONGODB_DB: t.dbName, MONGODB_COLLECTION_PREFIX: t.prefix });
  return createServerContext(env, { client, logger: createLogger({ level: "silent" }) });
}

let ipCounter = 0;
const freshIp = () => `100.64.0.${++ipCounter}`;

const getCategories = (ctx: ServerContext, ip: string) =>
  runApi(
    "GET /api/categories",
    testRequest("/api/categories", { method: "GET", origin: null, ip }),
    () => ctx,
    handleCategoriesRequest,
  );

const getHealth = (ctx: ServerContext, ip: string) =>
  runApi(
    "GET /api/health",
    testRequest("/api/health", { method: "GET", origin: null, ip }),
    () => ctx,
    handleHealthRequest,
    { onUnexpected: healthUnavailable },
  );

describe("GET /api/categories", () => {
  it("liefert nur spielbare Kategorien mit den öffentlichen Feldern, sortiert, CDN-cachebar", async () => {
    const response = await getCategories(context(), freshIp());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(CATEGORIES_CACHE_CONTROL);
    expect(CATEGORIES_CACHE_CONTROL).toBe("public, s-maxage=300, stale-while-revalidate=3600");
    const text = await response.text();
    expect(text).not.toMatch(/GEHEIM|scope|topics|playable|Count|description/);
    const body = categoriesResponseSchema.parse(JSON.parse(text));
    expect(body.categories).toEqual([
      { id: "erste", name: "Kategorie 1", icon: "book-open", color: "#3366FF", order: 1 },
      { id: "zweite", name: "Kategorie 2", icon: "book-open", color: "#3366FF", order: 2 },
    ]);
  });

  it("begrenzt auf 60 / min je IP → 429 (ohne öffentliches Caching)", async () => {
    const ctx = context();
    const ip = freshIp();
    for (let i = 0; i < 60; i++) expect((await getCategories(ctx, ip)).status).toBe(200);
    const limited = await getCategories(ctx, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  it("Datenbank weg → 503 SERVER_BUSY ohne Details", async () => {
    const response = await getCategories(context(unreachable), freshIp());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "SERVER_BUSY", message: "Dienst vorübergehend nicht verfügbar" },
    });
  });
});

describe("GET /api/health", () => {
  it("DB erreichbar → 200 { ok: true }, no-store", async () => {
    const response = await getHealth(context(), freshIp());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("DB weg → 503 { ok: false } ohne Details", async () => {
    const response = await getHealth(context(unreachable), freshIp());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  });

  it("begrenzt auf 60 / min je IP → 429, Antwort weiterhin nur { ok }", async () => {
    const ctx = context();
    const ip = freshIp();
    for (let i = 0; i < 60; i++) expect((await getHealth(ctx, ip)).status).toBe(200);
    const limited = await getHealth(ctx, ip);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false });
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  it("Kontext nicht baubar (z. B. Env ungültig) → 503 { ok: false }", async () => {
    // Ohne Kontext loggt runApi über den Prozess-Logger – im Test stumm.
    vi.stubEnv("LOG_LEVEL", "silent");
    const response = await runApi(
      "GET /api/health",
      testRequest("/api/health", { method: "GET", origin: null }),
      () => {
        throw new Error("Env kaputt");
      },
      handleHealthRequest,
      { onUnexpected: healthUnavailable },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
    vi.unstubAllEnvs();
  });
});

describe("Health-Probe", () => {
  it("cacht ~5 s, teilt laufende Pings und begrenzt die Wartezeit", async () => {
    let pings = 0;
    const clock = { now: 0 };
    const probe = createHealthProbe({
      ping: async () => {
        pings += 1;
      },
      logger: createLogger({ level: "silent" }),
      now: () => clock.now,
    });
    await Promise.all([probe.check(), probe.check(), probe.check()]);
    expect(pings).toBe(1);
    clock.now = 4_999;
    expect(await probe.check()).toBe(true);
    expect(pings).toBe(1);
    clock.now = 5_000;
    await probe.check();
    expect(pings).toBe(2);

    const hanging = createHealthProbe({
      ping: () => new Promise(() => undefined),
      logger: createLogger({ level: "silent" }),
      timeoutMs: 50,
    });
    expect(await hanging.check()).toBe(false);
  });
});
