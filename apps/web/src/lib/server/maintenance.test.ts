/**
 * Wartungshinweis für die Seiten (lib/server/maintenance.ts): appConfig.maintenance aus der Test-DB, Datenbank nicht
 * erreichbar → Hinweis ohne Text (docs/12 Runbook), Cache mit Aktualisierung im Hintergrund, nie Details nach außen.
 */
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { APP_CONFIG_ID } from "@quizmaster/shared/documents";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServerContext, type ServerContext } from "./context";
import { createLogger } from "./logger";
import { createMaintenanceProbe, DATABASE_DOWN_NOTICE } from "./maintenance";
import { testEnv } from "./test-support";

let t: TestDatabase;
let unreachable: MongoClient;

beforeAll(async () => {
  t = await createTestDatabase({ ensureIndexes: true });
  unreachable = new MongoClient("mongodb://127.0.0.1:9/?directConnection=true", {
    serverSelectionTimeoutMS: 300,
    connectTimeoutMS: 300,
  });
}, 60_000);

afterAll(async () => {
  await unreachable?.close();
  await t?.cleanup();
});

function context(client: MongoClient = t.client, now: () => number = Date.now): ServerContext {
  const env = testEnv({ MONGODB_DB: t.dbName, MONGODB_COLLECTION_PREFIX: t.prefix });
  return createServerContext(env, { client, logger: createLogger({ level: "silent" }), now });
}

async function setMaintenance(enabled: boolean, message: string | null): Promise<void> {
  await t.collections.appConfig.updateOne({ _id: APP_CONFIG_ID }, { $set: { maintenance: { enabled, message } } });
}

describe("Wartungshinweis", () => {
  it("appConfig.maintenance an → Hinweis mit Text; aus → kein Hinweis; ohne Text → Standardtext (message null)", async () => {
    await setMaintenance(true, "Kurze Wartung");
    expect(await createMaintenanceProbe(context()).current()).toEqual({ message: "Kurze Wartung" });
    await setMaintenance(true, null);
    expect(await createMaintenanceProbe(context()).current()).toEqual({ message: null });
    await setMaintenance(false, null);
    expect(await createMaintenanceProbe(context()).current()).toBeNull();
  });

  it("Datenbank nicht erreichbar → Hinweis ohne Text und ohne Details (kein Fehler für die Seite)", async () => {
    const notice = await createMaintenanceProbe(context(unreachable)).current();
    expect(notice).toBe(DATABASE_DOWN_NOTICE);
    expect(notice).toEqual({ message: null });
  });

  it("hängende Abfrage → nach der Frist Hinweis statt wartender Seite", async () => {
    const ctx = context();
    const stuck = {
      ...ctx,
      health: { check: async () => true },
      data: {
        ...ctx.data,
        collections: { ...ctx.data.collections, appConfig: { findOne: () => new Promise(() => undefined) } },
      },
    } as unknown as ServerContext;
    const started = Date.now();
    expect(await createMaintenanceProbe(stuck, { readTimeoutMs: 50 }).current()).toEqual({ message: null });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("Cache: innerhalb der Frist ohne Datenbank, danach sofort der alte Stand und Aktualisierung im Hintergrund", async () => {
    let now = 1_000_000;
    await setMaintenance(true, "eins");
    const probe = createMaintenanceProbe(
      context(t.client, () => now),
      { cacheMs: 10_000 },
    );
    expect(await probe.current()).toEqual({ message: "eins" });
    await setMaintenance(true, "zwei");
    now += 5_000;
    expect(await probe.current()).toEqual({ message: "eins" });
    now += 6_000;
    // Abgelaufen: liefert noch den alten Stand, aktualisiert im Hintergrund.
    expect(await probe.current()).toEqual({ message: "eins" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await probe.current()).toEqual({ message: "zwei" });
    await setMaintenance(false, null);
  });

  it("ungültiges Dokument → kein Hinweis (fail-safe für die Seite), fehlendes Dokument → kein Hinweis", async () => {
    // Absichtlich vertragswidrig (an den Typen vorbei, wie ein manueller Eingriff in die Datenbank).
    await t.db
      .collection<{ _id: string }>(t.collections.appConfig.collectionName)
      .updateOne({ _id: APP_CONFIG_ID }, { $set: { maintenance: { enabled: "ja" } } });
    expect(await createMaintenanceProbe(context()).current()).toBeNull();
    await t.collections.appConfig.deleteOne({ _id: APP_CONFIG_ID });
    expect(await createMaintenanceProbe(context()).current()).toBeNull();
  });
});
