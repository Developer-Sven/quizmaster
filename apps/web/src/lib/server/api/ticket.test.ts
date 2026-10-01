import { createRepositories } from "@quizmaster/db";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { REALTIME_TICKET, realtimeTicketClaimsSchema, SESSION_COOKIE } from "@quizmaster/shared";
import { ipKey } from "@quizmaster/shared/ip";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WebEnvSource } from "../../../env";
import { createServerContext, type ServerContext } from "../context";
import { createLogger } from "../logger";
import {
  SESSION_COOKIE_NAMES,
  sessionCookieOf,
  setCookies,
  TEST_SECRETS,
  TURNSTILE_TEST,
  testEnv,
  testRequest,
} from "../test-support";
import { hmacKey, signSessionToken } from "../tokens";
import { runApi } from "./route";
import { handleSessionRequest } from "./session";
import { handleTicketRequest } from "./ticket";

const DAY_SEC = 24 * 60 * 60;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const T0_SEC = Math.floor(T0 / 1000);

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase({ ensureIndexes: true });
}, 60_000);

afterAll(async () => {
  await t?.cleanup();
});

interface Harness {
  ctx: ServerContext;
  clock: { now: number };
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
}

function harness(overrides: WebEnvSource = {}, fetchImpl?: typeof fetch): Harness {
  const clock = { now: T0 };
  const fetchMock = vi.fn<typeof fetch>(fetchImpl ?? (async () => Response.json({ success: false })));
  const env = testEnv({ MONGODB_DB: t.dbName, MONGODB_COLLECTION_PREFIX: t.prefix, ...overrides });
  const ctx = createServerContext(env, {
    client: t.client,
    logger: createLogger({ level: "silent" }),
    fetch: fetchMock,
    now: () => clock.now,
  });
  return { ctx, clock, fetchMock };
}

let ipCounter = 0;
const freshIp = () => `192.0.2.${++ipCounter}`;

/** Gast in der DB + gültiges Session-Cookie (ausgestellt zu `issuedAtSec`). */
async function guestWithSession(issuedAtSec = T0_SEC): Promise<{ guestId: string; cookie: string }> {
  const guestId = crypto.randomUUID();
  await createRepositories(t.client, t.collections).guests.create(guestId, new Date(T0));
  const { token } = await signSessionToken(guestId, TEST_SECRETS.SESSION_SECRET, issuedAtSec);
  return { guestId, cookie: `kd_sid=${token}` };
}

function post(h: Harness, init: Parameters<typeof testRequest>[1] = {}) {
  return runApi(
    "POST /api/realtime/ticket",
    testRequest("/api/realtime/ticket", { body: {}, ...init }),
    () => h.ctx,
    handleTicketRequest,
  );
}

async function ticketOf(response: Response): Promise<string> {
  const body = (await response.json()) as { ticket: string };
  return body.ticket;
}

describe("POST /api/realtime/ticket – Ticket", () => {
  it("stellt ein JWT HS256 mit sub, aud=realtime, iss=web, 60 s und zufälliger jti aus", async () => {
    const h = harness();
    const { guestId, cookie } = await guestWithSession();
    const response = await post(h, { cookie, ip: freshIp() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const ticket = await ticketOf(response);

    expect(decodeProtectedHeader(ticket)).toEqual({ alg: "HS256", typ: "JWT" });
    // So prüft apps/realtime: Schlüssel = UTF-8-Bytes des Secrets, feste Audience/Issuer/Algorithmen.
    const { payload } = await jwtVerify(ticket, hmacKey(TEST_SECRETS.REALTIME_TICKET_SECRET), {
      algorithms: [REALTIME_TICKET.algorithm],
      audience: REALTIME_TICKET.audience,
      issuer: REALTIME_TICKET.issuer,
      currentDate: new Date(T0),
    });
    const claims = realtimeTicketClaimsSchema.parse(payload);
    expect(claims.sub).toBe(guestId);
    expect(claims.iat).toBe(T0_SEC);
    expect(claims.exp - (claims.iat ?? 0)).toBe(60);
    expect(claims.jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(claims.tsv).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "sub"]);

    await expect(
      jwtVerify(ticket, hmacKey(TEST_SECRETS.REALTIME_TICKET_SECRET), {
        algorithms: ["HS256"],
        currentDate: new Date(T0 + 61_000),
      }),
    ).rejects.toThrow();
  });

  it("vergibt jede jti nur einmal und signiert NICHT mit dem Session-Secret", async () => {
    const h = harness();
    const { cookie } = await guestWithSession();
    const ip = freshIp();
    const tickets = await Promise.all(Array.from({ length: 5 }, async () => ticketOf(await post(h, { cookie, ip }))));
    const jtis = tickets.map((ticket) => decodeJwt(ticket).jti);
    expect(new Set(jtis).size).toBe(5);
    await expect(
      jwtVerify(tickets[0] ?? "", hmacKey(TEST_SECRETS.SESSION_SECRET), { algorithms: ["HS256"] }),
    ).rejects.toThrow();
  });

  it("erneuert das Session-Cookie rollierend (< 30 Tage Rest), sonst nicht", async () => {
    const h = harness();
    const { guestId, cookie } = await guestWithSession(T0_SEC - 151 * DAY_SEC);
    const renewed = await post(h, { cookie, ip: freshIp() });
    expect(renewed.status).toBe(200);
    const next = decodeJwt(sessionCookieOf(renewed) ?? "");
    expect(next.sub).toBe(guestId);
    expect(next.exp).toBe(T0_SEC + SESSION_COOKIE.maxAgeSec);

    const fresh = await guestWithSession();
    expect(sessionCookieOf(await post(h, { cookie: fresh.cookie, ip: freshIp() }))).toBeUndefined();
  });

  it("setzt tsv nach erfolgreicher Turnstile-Prüfung; falsches Token → 403 TURNSTILE_REQUIRED", async () => {
    const siteverify: typeof fetch = async (_url, init) =>
      new URLSearchParams(String(init?.body)).get("response") === TURNSTILE_TEST.dummyToken
        ? Response.json({ success: true, hostname: "example.com" })
        : Response.json({ success: false, "error-codes": ["invalid-input-response"] });
    const h = harness(
      { TURNSTILE_SITE_KEY: TURNSTILE_TEST.siteKey, TURNSTILE_SECRET_KEY: TURNSTILE_TEST.secretKey },
      siteverify,
    );
    const { cookie } = await guestWithSession();
    const ok = await post(h, { cookie, ip: freshIp(), body: { turnstileToken: TURNSTILE_TEST.dummyToken } });
    expect(ok.status).toBe(200);
    expect(decodeJwt(await ticketOf(ok)).tsv).toBe(T0);

    const wrong = await post(h, { cookie, ip: freshIp(), body: { turnstileToken: "falsch" } });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("TURNSTILE_REQUIRED");
  });

  it("Token ohne konfiguriertes Turnstile-Secret → 503 (nie ein Ticket mit ungeprüftem tsv)", async () => {
    const h = harness();
    const { cookie } = await guestWithSession();
    const response = await post(h, { cookie, ip: freshIp(), body: { turnstileToken: "irgendwas" } });
    expect(response.status).toBe(503);
  });
});

describe("POST /api/realtime/ticket – Ablehnungen", () => {
  it("ohne oder mit ungültigem Cookie → 401 UNAUTHORIZED", async () => {
    const h = harness();
    const foreign = await signSessionToken(crypto.randomUUID(), "anderes-secret-0123456789abcdefghijklmnopq", T0_SEC);
    const expired = await signSessionToken(crypto.randomUUID(), TEST_SECRETS.SESSION_SECRET, 0);
    for (const cookie of [undefined, "kd_sid=kaputt", `kd_sid=${foreign.token}`, `kd_sid=${expired.token}`]) {
      const response = await post(h, { ip: freshIp(), ...(cookie === undefined ? {} : { cookie }) });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Keine gültige Session" } });
    }
  });

  it("https-APP_ORIGIN: Session nur aus __Host-kd_sid (ADR-033); kd_sid → 401, Erneuerung als __Host-kd_sid", async () => {
    const origin = "https://quiz.example.com";
    const h = harness({ APP_ORIGIN: origin, REALTIME_URL: "" });
    const { guestId, cookie } = await guestWithSession(T0_SEC - 151 * DAY_SEC);
    const token = cookie.slice("kd_sid=".length);

    const injected = await post(h, { origin, cookie: `kd_sid=${token}`, ip: freshIp() });
    expect(injected.status).toBe(401);

    const ok = await post(h, { origin, cookie: `__Host-kd_sid=${token}`, ip: freshIp() });
    expect(ok.status).toBe(200);
    expect(decodeJwt(await ticketOf(ok)).sub).toBe(guestId);
    const renewed = setCookies(ok);
    expect(renewed.map((entry) => entry.name)).toEqual([SESSION_COOKIE_NAMES.https]);
    expect(renewed[0]?.attributes.get("secure")).toBe(true);
    expect(decodeJwt(sessionCookieOf(ok, SESSION_COOKIE_NAMES.https) ?? "").sub).toBe(guestId);
  });

  it("gültiges Cookie, aber Gast gelöscht → 401", async () => {
    const h = harness();
    const { guestId, cookie } = await guestWithSession();
    await t.collections.guests.deleteOne({ _id: guestId });
    expect((await post(h, { cookie, ip: freshIp() })).status).toBe(401);
  });

  it("gesperrter Gast oder gesperrter IP-Schlüssel → 403 BANNED; abgelaufene Sperre zählt nicht", async () => {
    const h = harness();
    const bans = createRepositories(t.client, t.collections).bans;

    const banned = await guestWithSession();
    await bans.upsert({ kind: "guest", value: banned.guestId, reason: "Test" }, new Date(T0));
    const response = await post(h, { cookie: banned.cookie, ip: freshIp() });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("BANNED");

    const viaIp = await guestWithSession();
    const ip = freshIp();
    await bans.upsert(
      { kind: "ip", value: ipKey(ip, TEST_SECRETS.IP_HASH_SECRET) ?? "", reason: "Test" },
      new Date(T0),
    );
    expect((await post(h, { cookie: viaIp.cookie, ip })).status).toBe(403);

    const expired = await guestWithSession();
    await bans.upsert(
      { kind: "guest", value: expired.guestId, reason: "Test", expiresAt: new Date(T0 - 1_000) },
      new Date(T0 - 10_000),
    );
    expect((await post(h, { cookie: expired.cookie, ip: freshIp() })).status).toBe(200);
  });

  it("fremde Origin → 403", async () => {
    const h = harness();
    const { cookie } = await guestWithSession();
    expect((await post(h, { cookie, ip: freshIp(), origin: "https://evil.example.com" })).status).toBe(403);
  });

  it("begrenzt je Gast auf 30 / min → 429 mit Retry-After", async () => {
    const h = harness();
    const { cookie } = await guestWithSession();
    for (let i = 0; i < 30; i++) expect((await post(h, { cookie, ip: freshIp() })).status).toBe(200);
    const limited = await post(h, { cookie, ip: freshIp() });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(60);
  });

  it("begrenzt je IP auf 300 / min → 429 (auch ohne gültiges Cookie)", async () => {
    const h = harness();
    const ip = freshIp();
    for (let i = 0; i < 300; i++) expect((await post(h, { ip })).status).toBe(401);
    expect((await post(h, { ip })).status).toBe(429);
  });

  it("Anfragen ohne gültige Session sperren gültige Sessions derselben IP nicht aus (eigener IP-Eimer)", async () => {
    const h = harness();
    const ip = freshIp();
    const { cookie } = await guestWithSession();
    // Flut ohne bzw. mit kaputtem Cookie (Origin-Header außerhalb eines Browsers fälschbar) bis zum Limit …
    for (let i = 0; i < 300; i++) expect((await post(h, { ip })).status).toBe(401);
    expect((await post(h, { ip, cookie: "kd_sid=kaputt" })).status).toBe(429);
    // … trifft weder Tickets noch die Wiederverwendung gültiger Sessions hinter derselben IP (CGNAT, WLAN).
    expect((await post(h, { ip, cookie })).status).toBe(200);
    const reuse = await runApi(
      "POST /api/session",
      testRequest("/api/session", { body: {}, cookie, ip }),
      () => h.ctx,
      handleSessionRequest,
    );
    expect(reuse.status).toBe(200);
  });

  it("zählt gültige Sessions gegen IP und Gast, Anfragen ohne Session getrennt – weiter je IP", async () => {
    const h = harness();
    const consume = vi.spyOn(h.ctx.limiters, "consume");
    const ip = freshIp();
    const otherIp = freshIp();
    const key = ipKey(ip, TEST_SECRETS.IP_HASH_SECRET) ?? "";
    const { guestId, cookie } = await guestWithSession();

    expect((await post(h, { ip, cookie })).status).toBe(200);
    expect(consume.mock.calls).toEqual([
      ["POST /api/realtime/ticket", "ip", key],
      ["POST /api/realtime/ticket", "guest", guestId],
    ]);

    consume.mockClear();
    expect((await post(h, { ip })).status).toBe(401);
    expect((await post(h, { ip: otherIp })).status).toBe(401);
    const [own, other] = consume.mock.calls.map(([endpoint, scope, bucket]) => ({ endpoint, scope, bucket }));
    expect(consume).toHaveBeenCalledTimes(2);
    expect(own).toMatchObject({ endpoint: "POST /api/realtime/ticket", scope: "ip" });
    expect(own?.bucket).not.toBe(key);
    expect(own?.bucket).toContain(key);
    expect(other?.bucket).not.toBe(own?.bucket);
  });
});
