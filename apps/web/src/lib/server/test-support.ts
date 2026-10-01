/**
 * Helfer für die Tests der Web-Serverseite (nicht Teil der App). Secrets sind Test-Konstanten.
 */
import { NextRequest } from "next/server";
import { parseWebEnv, type WebEnv, type WebEnvSource } from "../../env";

export const TEST_ORIGIN = "http://localhost:3120";

export const TEST_SECRETS = {
  SESSION_SECRET: "test-session-secret-0123456789abcdefghijklmnop",
  REALTIME_TICKET_SECRET: "test-ticket-secret-0123456789abcdefghijklmnopq",
  IP_HASH_SECRET: "test-ip-hash-secret-0123456789abcdefghijklmnop",
} as const;

/** Cloudflare-Test-Schlüssel (immer gültig) und das dazugehörige Platzhalter-Token. */
export const TURNSTILE_TEST = {
  siteKey: "1x00000000000000000000AA",
  secretKey: "1x0000000000000000000000000000000AA",
  dummyToken: "XXXX.DUMMY.TOKEN.XXXX",
} as const;

/** Env-Quelle für Tests (ohne echte Datenbank-URI, wenn keine übergeben wird). */
export function testEnvSource(overrides: WebEnvSource = {}): WebEnvSource {
  return {
    NODE_ENV: "test",
    APP_ORIGIN: TEST_ORIGIN,
    REALTIME_URL: "http://localhost:3121",
    MONGODB_URI: "mongodb://127.0.0.1:27017/?replicaSet=rs0",
    MONGODB_DB: "quizmaster_test",
    ...TEST_SECRETS,
    LOG_LEVEL: "silent",
    ...overrides,
  };
}

export function testEnv(overrides: WebEnvSource = {}): WebEnv {
  return parseWebEnv(testEnvSource(overrides));
}

export interface TestRequestInit {
  method?: string;
  origin?: string | null;
  cookie?: string;
  ip?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** NextRequest wie vom Browser: gleiche Origin, `x-forwarded-for` wie vom Next-Server gesetzt. */
export function testRequest(path: string, init: TestRequestInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  const origin = init.origin === undefined ? TEST_ORIGIN : init.origin;
  if (origin !== null) headers.set("origin", origin);
  headers.set("x-forwarded-for", init.ip ?? "203.0.113.10");
  if (init.cookie !== undefined) headers.set("cookie", init.cookie);
  const method = init.method ?? "POST";
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    headers.set("content-type", "application/json");
  }
  return new NextRequest(new URL(path, TEST_ORIGIN), { method, headers, ...(body === undefined ? {} : { body }) });
}

export interface ParsedCookie {
  name: string;
  value: string;
  attributes: Map<string, string | true>;
}

/** Zerlegt `Set-Cookie`-Header einer Antwort. */
export function setCookies(response: Response): ParsedCookie[] {
  return response.headers.getSetCookie().map((line) => {
    const [pair = "", ...parts] = line.split(";");
    const index = pair.indexOf("=");
    const attributes = new Map<string, string | true>();
    for (const part of parts) {
      const [key = "", ...rest] = part.trim().split("=");
      attributes.set(key.toLowerCase(), rest.length === 0 ? true : rest.join("="));
    }
    return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), attributes };
  });
}

/** Name des Session-Cookies bei http-APP_ORIGIN (Tests) und bei https (Produktion, ADR-033). */
export const SESSION_COOKIE_NAMES = { http: "kd_sid", https: "__Host-kd_sid" } as const;

/** Wert des Session-Cookies einer Antwort (oder `undefined`); Standard: Name bei http-APP_ORIGIN. */
export function sessionCookieOf(response: Response, name: string = SESSION_COOKIE_NAMES.http): string | undefined {
  return setCookies(response).find((cookie) => cookie.name === name)?.value;
}
