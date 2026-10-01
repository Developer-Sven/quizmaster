import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { SESSION_COOKIE } from "@quizmaster/shared";
import { decodeJwt } from "jose";
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
import { signSessionToken } from "../tokens";
import { TURNSTILE_SITEVERIFY_URL } from "../turnstile";
import { runApi } from "./route";
import { handleSessionRequest } from "./session";

const DAY_SEC = 24 * 60 * 60;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

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
/** Eigene IP je Test, damit sich die (persistenten) IP-Limits nicht gegenseitig beeinflussen. */
const freshIp = () => `198.51.100.${++ipCounter}`;

function post(h: Harness, init: Parameters<typeof testRequest>[1] = {}) {
  return runApi(
    "POST /api/session",
    testRequest("/api/session", { body: {}, ...init }),
    () => h.ctx,
    handleSessionRequest,
  );
}

async function guestCount(): Promise<number> {
  return t.collections.guests.countDocuments();
}

describe("POST /api/session – anlegen, weiterverwenden, rollierend erneuern", () => {
  it("legt einen Gast an und setzt kd_sid (HttpOnly, SameSite=Lax, Path=/, 180 Tage, ohne Secure bei http)", async () => {
    const h = harness();
    const before = await guestCount();
    const response = await post(h, { ip: freshIp() });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ created: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [cookie] = setCookies(response);
    expect(cookie?.name).toBe("kd_sid");
    expect(cookie?.attributes.get("httponly")).toBe(true);
    expect(String(cookie?.attributes.get("samesite")).toLowerCase()).toBe("lax");
    expect(cookie?.attributes.get("path")).toBe("/");
    expect(cookie?.attributes.get("max-age")).toBe(String(SESSION_COOKIE.maxAgeSec));
    expect(cookie?.attributes.has("secure")).toBe(false);

    const claims = decodeJwt(cookie?.value ?? "");
    expect(claims.sub).toMatch(/^[0-9a-f-]{36}$/);
    expect(claims.exp).toBe(Math.floor(T0 / 1000) + SESSION_COOKIE.maxAgeSec);
    expect(await guestCount()).toBe(before + 1);
    const guest = await t.collections.guests.findOne({ _id: String(claims.sub) });
    expect(guest?.createdAt.getTime()).toBe(T0);
  });

  it("setzt Secure bei https-APP_ORIGIN (Produktion)", async () => {
    const h = harness({ APP_ORIGIN: "https://quiz.example.com", REALTIME_URL: "" });
    const response = await post(h, { origin: "https://quiz.example.com", ip: freshIp() });
    expect(response.status).toBe(201);
    expect(setCookies(response)[0]?.attributes.get("secure")).toBe(true);
    expect(setCookies(response)[0]?.name).toBe(SESSION_COOKIE_NAMES.https);
  });

  it("verwendet eine gültige Session weiter (kein neuer Gast, lastSeen aktualisiert, kein neues Cookie)", async () => {
    const h = harness();
    const ip = freshIp();
    const created = await post(h, { ip });
    const token = sessionCookieOf(created) ?? "";
    const guestId = String(decodeJwt(token).sub);
    const before = await guestCount();

    h.clock.now = T0 + 5 * DAY_SEC * 1000;
    const reused = await post(h, { ip, cookie: `kd_sid=${token}` });
    expect(reused.status).toBe(200);
    expect(await reused.json()).toEqual({ created: false });
    expect(setCookies(reused)).toEqual([]);
    expect(await guestCount()).toBe(before);
    const guest = await t.collections.guests.findOne({ _id: guestId });
    expect(guest?.lastSeenAt.getTime()).toBe(h.clock.now);
  });

  it("erneuert rollierend, wenn weniger als 30 Tage Restlaufzeit bleiben", async () => {
    const h = harness();
    const ip = freshIp();
    const token = sessionCookieOf(await post(h, { ip })) ?? "";
    const guestId = String(decodeJwt(token).sub);

    h.clock.now = T0 + 151 * DAY_SEC * 1000; // 29 Tage Rest
    const renewed = await post(h, { ip, cookie: `kd_sid=${token}` });
    expect(renewed.status).toBe(200);
    const next = sessionCookieOf(renewed);
    expect(next).toBeDefined();
    const claims = decodeJwt(next ?? "");
    expect(claims.sub).toBe(guestId);
    expect(claims.exp).toBe(Math.floor(h.clock.now / 1000) + SESSION_COOKIE.maxAgeSec);

    h.clock.now = T0 + 149 * DAY_SEC * 1000; // 31 Tage Rest → keine Erneuerung
    expect(setCookies(await post(h, { ip, cookie: `kd_sid=${token}` }))).toEqual([]);
  });

  it("legt bei ungültigem, fremd signiertem oder abgelaufenem Cookie einen neuen Gast an", async () => {
    const h = harness();
    const ip = freshIp();
    const foreign = await signSessionToken(crypto.randomUUID(), "fremdes-secret-0123456789abcdefghijklmnopq", 0);
    const expired = await signSessionToken(crypto.randomUUID(), TEST_SECRETS.SESSION_SECRET, 0);
    for (const cookie of ["kd_sid=kaputt", `kd_sid=${foreign.token}`, `kd_sid=${expired.token}`]) {
      const response = await post(h, { ip, cookie });
      expect(response.status).toBe(201);
      expect(sessionCookieOf(response)).toBeDefined();
    }
  });

  it("legt einen neuen Gast an, wenn der Gast zur gültigen Session nicht mehr existiert", async () => {
    const h = harness();
    const ip = freshIp();
    const token = sessionCookieOf(await post(h, { ip })) ?? "";
    await t.collections.guests.deleteOne({ _id: String(decodeJwt(token).sub) });
    const response = await post(h, { ip, cookie: `kd_sid=${token}` });
    expect(response.status).toBe(201);
    expect(decodeJwt(sessionCookieOf(response) ?? "").sub).not.toBe(decodeJwt(token).sub);
  });
});

describe("POST /api/session – Schutz", () => {
  it("lehnt fremde, fehlende oder 'null'-Origin mit 403 ab (CSRF) – ohne Gast anzulegen", async () => {
    const h = harness();
    const before = await guestCount();
    for (const origin of ["https://evil.example.com", null, "null"]) {
      const response = await post(h, { origin, ip: freshIp() });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Origin nicht erlaubt" } });
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(await guestCount()).toBe(before);
  });

  it("lehnt unbekannte Felder, kein JSON und zu große Bodys mit 400 ab", async () => {
    const h = harness();
    for (const body of [{ extra: 1 }, "{kein json", { turnstileToken: "x".repeat(5_000) }]) {
      const response = await post(h, { body, ip: freshIp() });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("begrenzt das Anlegen neuer Sessions auf 10 / 10 min je IP (Mongo-Store) → 429 mit Retry-After", async () => {
    const h = harness();
    const ip = freshIp();
    const before = await guestCount();
    for (let i = 0; i < 10; i++) expect((await post(h, { ip })).status).toBe(201);
    const limited = await post(h, { ip });
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: { code: string; retryAfterMs: number } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(600);
    expect(await guestCount()).toBe(before + 10);
    // Andere IP ist nicht betroffen; der Zähler liegt in der Collection rateLimits (mit Test-Präfix).
    expect((await post(h, { ip: freshIp() })).status).toBe(201);
    expect(await t.db.collection(`${t.prefix}rateLimits`).countDocuments()).toBeGreaterThan(0);
  });

  it("zählt nur NEUE Sessions: Weiterverwenden und Erneuern hinter einer gemeinsamen IP verbrauchen nichts", async () => {
    const h = harness();
    const ip = freshIp();
    const token = sessionCookieOf(await post(h, { ip })) ?? "";
    // Viele Seitenaufrufe/Reloads mit gültigem Cookie (WLAN, CGNAT) …
    for (let i = 0; i < 15; i++) expect((await post(h, { ip, cookie: `kd_sid=${token}` })).status).toBe(200);
    // … auch rollierende Erneuerungen (< 30 Tage Rest) …
    h.clock.now = T0 + 151 * DAY_SEC * 1000;
    const renewed = await post(h, { ip, cookie: `kd_sid=${token}` });
    expect(renewed.status).toBe(200);
    expect(sessionCookieOf(renewed)).toBeDefined();
    // … lassen das Anlege-Kontingent unberührt: 9 weitere neue Gäste gehen noch, der 11. nicht.
    for (let i = 0; i < 9; i++) expect((await post(h, { ip })).status).toBe(201);
    expect((await post(h, { ip })).status).toBe(429);
    // Wer schon eine gültige Session hat, ist vom ausgeschöpften Anlege-Limit nicht betroffen.
    expect((await post(h, { ip, cookie: `kd_sid=${token}` })).status).toBe(200);
  });

  it("RATE_LIMIT_MODE=relaxed (nur *_test) hebt das Limit ×100 an", async () => {
    const h = harness({ RATE_LIMIT_MODE: "relaxed" });
    const ip = freshIp();
    for (let i = 0; i < 20; i++) expect((await post(h, { ip })).status).toBe(201);
  });
});

describe("POST /api/session – Cookie-Härtung (ADR-033)", () => {
  const HTTPS_ORIGIN = "https://quiz.example.com";
  const https = { APP_ORIGIN: HTTPS_ORIGIN, REALTIME_URL: "" };

  it("https-APP_ORIGIN: __Host-kd_sid mit Secure, Path=/ und ohne Domain", async () => {
    const h = harness(https);
    const response = await post(h, { origin: HTTPS_ORIGIN, ip: freshIp() });
    expect(response.status).toBe(201);
    const cookies = setCookies(response);
    expect(cookies.map((cookie) => cookie.name)).toEqual([SESSION_COOKIE_NAMES.https]);
    const [cookie] = cookies;
    expect(cookie?.attributes.get("secure")).toBe(true);
    expect(cookie?.attributes.get("path")).toBe("/");
    expect(cookie?.attributes.has("domain")).toBe(false);
    expect(cookie?.attributes.get("httponly")).toBe(true);
    expect(String(cookie?.attributes.get("samesite")).toLowerCase()).toBe("lax");
  });

  it("https: liest nur __Host-kd_sid – ein untergeschobenes kd_sid (z. B. von einer Subdomain) zählt nicht", async () => {
    const h = harness(https);
    const ip = freshIp();
    const token = sessionCookieOf(await post(h, { origin: HTTPS_ORIGIN, ip }), SESSION_COOKIE_NAMES.https) ?? "";
    const guestId = String(decodeJwt(token).sub);

    const reused = await post(h, { origin: HTTPS_ORIGIN, ip, cookie: `__Host-kd_sid=${token}` });
    expect(reused.status).toBe(200);

    const injected = await post(h, { origin: HTTPS_ORIGIN, ip, cookie: `kd_sid=${token}` });
    expect(injected.status).toBe(201);
    const fresh = sessionCookieOf(injected, SESSION_COOKIE_NAMES.https) ?? "";
    expect(decodeJwt(fresh).sub).not.toBe(guestId);

    // Erneuerung schreibt ebenfalls __Host-kd_sid.
    h.clock.now = T0 + 151 * DAY_SEC * 1000;
    const renewed = await post(h, { origin: HTTPS_ORIGIN, ip, cookie: `__Host-kd_sid=${token}` });
    expect(setCookies(renewed).map((cookie) => cookie.name)).toEqual([SESSION_COOKIE_NAMES.https]);
  });

  it("http (Dev/Test): kd_sid ohne Secure; ein __Host-kd_sid wird dort nicht gelesen", async () => {
    const h = harness();
    const ip = freshIp();
    const created = await post(h, { ip });
    expect(setCookies(created).map((cookie) => cookie.name)).toEqual([SESSION_COOKIE_NAMES.http]);
    const token = sessionCookieOf(created) ?? "";
    expect((await post(h, { ip, cookie: `__Host-kd_sid=${token}` })).status).toBe(201);
    expect((await post(h, { ip, cookie: `kd_sid=${token}` })).status).toBe(200);
  });
});

describe("POST /api/session – Turnstile (TURNSTILE_ENABLED=true)", () => {
  const turnstileEnv = {
    TURNSTILE_ENABLED: "true",
    TURNSTILE_SITE_KEY: TURNSTILE_TEST.siteKey,
    TURNSTILE_SECRET_KEY: TURNSTILE_TEST.secretKey,
  };

  /** Siteverify-Attrappe: nur das Cloudflare-Platzhalter-Token ist gültig. */
  const siteverify: typeof fetch = async (_url, init) => {
    const params = new URLSearchParams(String(init?.body));
    return params.get("response") === TURNSTILE_TEST.dummyToken
      ? Response.json({ success: true, "error-codes": [], hostname: "example.com" })
      : Response.json({ success: false, "error-codes": ["invalid-input-response"] });
  };

  it("ohne Token → 403 TURNSTILE_REQUIRED, kein Gast", async () => {
    const h = harness(turnstileEnv, siteverify);
    const before = await guestCount();
    const response = await post(h, { ip: freshIp() });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("TURNSTILE_REQUIRED");
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(await guestCount()).toBe(before);
  });

  it("mit falschem Token → 403 TURNSTILE_REQUIRED", async () => {
    const h = harness(turnstileEnv, siteverify);
    const response = await post(h, { ip: freshIp(), body: { turnstileToken: "falsch" } });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("TURNSTILE_REQUIRED");
  });

  it("mit gültigem Token → 201; Siteverify mit secret, response, remoteip, idempotency_key; Token nur einmal", async () => {
    const h = harness(turnstileEnv, siteverify);
    const ip = freshIp();
    const response = await post(h, { ip, body: { turnstileToken: TURNSTILE_TEST.dummyToken } });
    expect(response.status).toBe(201);
    expect(sessionCookieOf(response)).toBeDefined();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(init?.method).toBe("POST");
    const params = new URLSearchParams(String(init?.body));
    expect(params.get("secret")).toBe(TURNSTILE_TEST.secretKey);
    expect(params.get("response")).toBe(TURNSTILE_TEST.dummyToken);
    expect(params.get("remoteip")).toBe(ip);
    expect(params.get("idempotency_key")).toMatch(/^[0-9a-f-]{36}$/);

    const replay = await post(h, { ip, body: { turnstileToken: TURNSTILE_TEST.dummyToken } });
    expect(replay.status).toBe(403);
  });

  it("eine bestehende gültige Session braucht kein neues Token", async () => {
    const h = harness(turnstileEnv, siteverify);
    const ip = freshIp();
    const created = await post(h, { ip, body: { turnstileToken: TURNSTILE_TEST.dummyToken } });
    const reused = await post(h, { ip, cookie: `kd_sid=${sessionCookieOf(created) ?? ""}` });
    expect(reused.status).toBe(200);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Siteverify lehnt das Secret ab (falsch/rotiert) → 503 SERVER_BUSY statt 403, kein Gast", async () => {
    const wrongSecret = { ...turnstileEnv, TURNSTILE_SECRET_KEY: "0x4AAAAAAA-rotierter-alter-schluessel" };
    const h = harness(wrongSecret, async () =>
      Response.json({ success: false, "error-codes": ["invalid-input-secret"] }),
    );
    const before = await guestCount();
    const response = await post(h, { ip: freshIp(), body: { turnstileToken: "token-d" } });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("SERVER_BUSY");
    expect(await guestCount()).toBe(before);
  });

  it("prüft den Hostnamen bei echten Schlüsseln; Siteverify nicht erreichbar → 503", async () => {
    const realKeys = { ...turnstileEnv, TURNSTILE_SECRET_KEY: "0x4AAAAAAAtest-secret-key-for-hostname-check" };
    const foreignHost = harness(realKeys, async () => Response.json({ success: true, hostname: "evil.example.com" }));
    expect((await post(foreignHost, { ip: freshIp(), body: { turnstileToken: "token-a" } })).status).toBe(403);

    const ownHost = harness(realKeys, async () => Response.json({ success: true, hostname: "localhost" }));
    expect((await post(ownHost, { ip: freshIp(), body: { turnstileToken: "token-b" } })).status).toBe(201);

    const down = harness(realKeys, async () => {
      throw new TypeError("fetch failed");
    });
    const response = await post(down, { ip: freshIp(), body: { turnstileToken: "token-c" } });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("SERVER_BUSY");
    expect(down.fetchMock).toHaveBeenCalledTimes(2);
    const keys = down.fetchMock.mock.calls.map(([, init]) =>
      new URLSearchParams(String(init?.body)).get("idempotency_key"),
    );
    expect(keys[0]).toBe(keys[1]);
  });
});
