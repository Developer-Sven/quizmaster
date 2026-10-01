/**
 * Verdrahtung der echten Route-Module (`route.ts`): Env aus `process.env` (Test-DB), Prozess-Kontext,
 * Session → Ticket → Kategorien → Health wie der Client sie aufruft.
 */
import { closeMongoClient } from "@quizmaster/db";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clearWebEnvCache } from "../../env";
import { getServerContext } from "../../lib/server/context";
import { sessionCookieOf, testEnvSource, testRequest } from "../../lib/server/test-support";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase({ ensureIndexes: true });
  clearWebEnvCache();
  const source = testEnvSource({
    MONGODB_URI: t.uri,
    MONGODB_DB: t.dbName,
    MONGODB_COLLECTION_PREFIX: t.prefix,
  });
  for (const [key, value] of Object.entries(source)) vi.stubEnv(key, value);
}, 60_000);

afterAll(async () => {
  await closeMongoClient(getServerContext().data.client);
  vi.unstubAllEnvs();
  clearWebEnvCache();
  await t?.cleanup();
});

describe("API-Routen (route.ts) mit Prozess-Env", () => {
  it("Session → Ticket → Kategorien → Health", async () => {
    const session = await import("./session/route");
    const ticket = await import("./realtime/ticket/route");
    const categories = await import("./categories/route");
    const health = await import("./health/route");
    for (const route of [session, ticket, categories, health]) {
      expect(route.dynamic).toBe("force-dynamic");
      expect(route.runtime).toBe("nodejs");
    }

    const created = await session.POST(testRequest("/api/session", { body: {} }));
    expect(created.status).toBe(201);
    const token = sessionCookieOf(created) ?? "";
    const guestId = String(decodeJwt(token).sub);
    expect(await t.collections.guests.countDocuments({ _id: guestId })).toBe(1);

    const issued = await ticket.POST(testRequest("/api/realtime/ticket", { body: {}, cookie: `kd_sid=${token}` }));
    expect(issued.status).toBe(200);
    const body = (await issued.json()) as { ticket: string };
    expect(decodeJwt(body.ticket)).toMatchObject({ sub: guestId, aud: "realtime", iss: "web" });

    const denied = await ticket.POST(testRequest("/api/realtime/ticket", { body: {} }));
    expect(denied.status).toBe(401);

    const list = await categories.GET(testRequest("/api/categories", { method: "GET", origin: null }));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ categories: [] });

    const ok = await health.GET(testRequest("/api/health", { method: "GET", origin: null }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });
});
