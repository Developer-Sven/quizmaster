import { Writable } from "node:stream";
import { ipKey } from "@quizmaster/shared/ip";
import type { NextConfig } from "next";
import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../../next.config";
import { clearWebEnvCache } from "../../env";
import { proxy, config as proxyConfig } from "../../proxy";
import { ApiError } from "./http";
import { createLogger, hashGuestId } from "./logger";
import { assertAllowedOrigin, clientAddress, resolveRequestIp, UNKNOWN_IP_KEY } from "./request-guards";
import { publicRuntimeConfigFrom } from "./runtime-config";
import {
  buildContentSecurityPolicy,
  createNonce,
  HSTS_VALUE,
  HTML_CACHE_CONTROL,
  pageSecurityHeaders,
  realtimeConnectSources,
} from "./security-headers";
import { TEST_SECRETS, TURNSTILE_TEST, testEnv, testEnvSource } from "./test-support";

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));

describe("CSP (docs/06)", () => {
  it("setzt Nonce und strict-dynamic, Styles ohne Nonce und alle Pflicht-Direktiven", () => {
    const csp = buildContentSecurityPolicy("abc123==", testEnv());
    expect(directive(csp, "script-src")).toBe("script-src 'self' 'nonce-abc123==' 'strict-dynamic'");
    expect(directive(csp, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "img-src")).toBe("img-src 'self' data: blob:");
    expect(directive(csp, "frame-src")).toBe("frame-src https://challenges.cloudflare.com");
    for (const required of [
      "font-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "media-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(required);
    }
    expect(csp).not.toContain("unsafe-eval");
    expect(directive(csp, "upgrade-insecure-requests")).toBeUndefined();
  });

  it("connect-src enthält die Realtime-Origin aus REALTIME_URL (ws + http) und Turnstile", () => {
    const csp = buildContentSecurityPolicy("n", testEnv({ REALTIME_URL: "http://localhost:4000" }));
    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' ws://localhost:4000 http://localhost:4000 https://challenges.cloudflare.com",
    );
  });

  it("gleiche Origin (REALTIME_URL leer): wss/https jeder APP_ORIGIN, dazu upgrade-insecure-requests", () => {
    const env = testEnv({ APP_ORIGIN: "https://quiz.example.com,https://www.quiz.example.com", REALTIME_URL: "" });
    expect(realtimeConnectSources(env)).toEqual([
      "wss://quiz.example.com",
      "https://quiz.example.com",
      "wss://www.quiz.example.com",
      "https://www.quiz.example.com",
    ]);
    const csp = buildContentSecurityPolicy("n", env);
    expect(csp.endsWith("; upgrade-insecure-requests")).toBe(true);
  });

  it("erlaubt 'unsafe-eval' nur in next dev", () => {
    expect(buildContentSecurityPolicy("n", testEnv({ NODE_ENV: "development" }))).toContain(
      "'strict-dynamic' 'unsafe-eval'",
    );
    expect(buildContentSecurityPolicy("n", testEnv({ NODE_ENV: "production" }))).not.toContain("unsafe-eval");
  });

  it("erzeugt pro Aufruf eine neue 128-Bit-Nonce (Base64)", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createNonce()));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("HSTS nur bei https-APP_ORIGIN, noindex solange SEARCH_INDEXING aus ist", () => {
    expect(pageSecurityHeaders(testEnv())).toEqual([["X-Robots-Tag", "noindex, nofollow"]]);
    expect(pageSecurityHeaders(testEnv({ APP_ORIGIN: "https://quiz.example.com", SEARCH_INDEXING: "true" }))).toEqual([
      ["Strict-Transport-Security", HSTS_VALUE],
    ]);
  });
});

describe("proxy.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearWebEnvCache();
  });

  const stubEnv = (overrides: Record<string, string> = {}) => {
    clearWebEnvCache();
    for (const [key, value] of Object.entries(testEnvSource(overrides))) vi.stubEnv(key, value);
  };

  it("setzt pro Request eine neue Nonce in CSP-Antwortheader und Request-Header (x-nonce + CSP für Next)", () => {
    stubEnv();
    const first = proxy(new NextRequest("http://localhost:3120/"));
    const second = proxy(new NextRequest("http://localhost:3120/lobby/ABC234"));
    const csp = first.headers.get("content-security-policy") ?? "";
    const nonce = first.headers.get("x-middleware-request-x-nonce");
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    expect(directive(csp, "connect-src")).toContain("ws://localhost:3121 http://localhost:3121");
    expect(second.headers.get("x-middleware-request-x-nonce")).not.toBe(nonce);
    expect(first.headers.get("strict-transport-security")).toBeNull();
    expect(first.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("Next findet die Nonce in unserer CSP (gleiche Extraktion wie beim Rendern)", () => {
    stubEnv();
    const response = proxy(new NextRequest("http://localhost:3120/"));
    const csp = response.headers.get("x-middleware-request-content-security-policy") ?? "";
    expect(getScriptNonceFromHeader(csp)).toBe(response.headers.get("x-middleware-request-x-nonce"));
  });

  it("HTML-Dokumente: Cache-Control no-store + no-transform; RSC-/Asset-Requests behalten Nexts Standard", () => {
    stubEnv();
    const document = proxy(
      new NextRequest("http://localhost:3120/", { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } }),
    );
    expect(document.headers.get("cache-control")).toBe(HTML_CACHE_CONTROL);
    expect(HTML_CACHE_CONTROL).toContain("no-transform");
    const rsc = proxy(new NextRequest("http://localhost:3120/lobby/ABC234", { headers: { accept: "*/*", rsc: "1" } }));
    expect(rsc.headers.get("cache-control")).toBeNull();
  });

  it("setzt HSTS bei https-Origin", () => {
    stubEnv({ APP_ORIGIN: "https://quiz.example.com", REALTIME_URL: "" });
    const response = proxy(new NextRequest("https://quiz.example.com/"));
    expect(response.headers.get("strict-transport-security")).toBe(HSTS_VALUE);
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self' wss://quiz.example.com");
  });

  const matches = (url: string, headers?: Record<string, string>) =>
    unstable_doesMiddlewareMatch({
      config: proxyConfig,
      url,
      ...(headers === undefined ? {} : { headers }),
      nextConfig: nextConfig as NextConfig,
    });

  it("Matcher: Seiten ja – API, statische Assets, Service Worker, Flaggen und Dateien nein", () => {
    for (const page of ["/", "/lobby/ABC234", "/j/ABC234", "/regeln", "/offline", "/dev/ui", "/apiary"]) {
      expect(matches(page), page).toBe(true);
    }
    for (const asset of [
      "/api/session",
      "/api/health",
      "/api",
      "/_next/static/chunks/main.js",
      "/sw.js",
      "/flags/de.svg",
      "/favicon.ico",
      "/manifest.webmanifest",
      "/robots.txt",
      "/icon.png",
    ]) {
      expect(matches(asset), asset).toBe(false);
    }
  });

  it("Matcher: /_next/image läuft durch den Proxy – ohne Bildoptimierer liefert Next dort die 404-Seite (HTML)", () => {
    expect(matches("/_next/image?url=%2Ficons%2Ficon-192.png&w=64&q=75")).toBe(true);
    expect(matches("/_next/image", { accept: "text/html" })).toBe(true);
  });

  it("Matcher: auch Prefetches – sie können HTML liefern, und jedes HTML braucht CSP, HSTS und noindex", () => {
    // Browser-Prefetch (`Purpose`/`Sec-Purpose: prefetch`, Accept text/html) und `Next-Router-Prefetch` ohne `RSC`
    // liefern die vollständige Seite samt Skripten; ein übersprungener Proxy ließe sie ohne Nonce-CSP durch.
    const prefetches: Record<string, string>[] = [
      { accept: "text/html,application/xhtml+xml,*/*;q=0.8", purpose: "prefetch" },
      { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "sec-purpose": "prefetch" },
      { accept: "text/html", "next-router-prefetch": "1" },
      { accept: "*/*", rsc: "1", "next-router-prefetch": "1" },
    ];
    for (const headers of prefetches) {
      for (const page of ["/", "/regeln", "/lobby/ABC234"]) {
        expect(matches(page, { ...headers }), `${page} ${JSON.stringify(headers)}`).toBe(true);
      }
    }
  });

  it("HTML auf Prefetch-Anfragen bekommt dieselben Header wie jede Seite", () => {
    stubEnv({ APP_ORIGIN: "https://quiz.example.com", REALTIME_URL: "" });
    const response = proxy(
      new NextRequest("https://quiz.example.com/regeln", {
        headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8", purpose: "prefetch" },
      }),
    );
    const nonce = response.headers.get("x-middleware-request-x-nonce");
    expect(directive(response.headers.get("content-security-policy") ?? "", "script-src")).toBe(
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    );
    expect(response.headers.get("strict-transport-security")).toBe(HSTS_VALUE);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("cache-control")).toBe(HTML_CACHE_CONTROL);
  });
});

describe("next.config.ts headers()", () => {
  it("setzt die env-unabhängigen Sicherheitsheader global, strikte CSP für die API und SW-Header", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const headersFor = (source: string) =>
      Object.fromEntries((rules.find((rule) => rule.source === source)?.headers ?? []).map((h) => [h.key, h.value]));
    expect(headersFor("/:path*")).toEqual({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    });
    expect(headersFor("/api/:path*")["Content-Security-Policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(headersFor("/sw.js")).toEqual({
      "Cache-Control": "no-cache",
      "Content-Type": "application/javascript; charset=utf-8",
    });
    expect(nextConfig.poweredByHeader).toBe(false);
    expect(nextConfig.output).toBe("standalone");
  });

  it("liefert Preloads als Tag im HTML statt als Link-Header (keine doppelten Schrift-Preloads mit Service Worker)", () => {
    // Mit `Link`-Header legt React beim Hydrieren ein zweites Preload an; aus dem SW geladen, meldet Chromium
    // dann „preloaded … but not used“ für beide Schriften (Befund aus dem UI-Review: Schrift-Preloads mit aktivem SW).
    expect(nextConfig.reactMaxHeadersLength).toBe(0);
  });

  it("schaltet den Bildoptimierer ab: kein next/image im Projekt – /_next/image antwortet 404 (docs/06 Angriffsfläche)", () => {
    // Next beantwortet /_next/image mit `images.unoptimized` sofort mit 404, ohne sharp/libvips anzufassen.
    expect(nextConfig.images?.unoptimized).toBe(true);
  });
});

describe("getPublicRuntimeConfig / publicRuntimeConfigFrom (ADR-023)", () => {
  it("enthält nur öffentliche Werte", () => {
    const config = publicRuntimeConfigFrom(
      testEnv({
        TURNSTILE_ENABLED: "true",
        TURNSTILE_SITE_KEY: TURNSTILE_TEST.siteKey,
        TURNSTILE_SECRET_KEY: TURNSTILE_TEST.secretKey,
      }),
    );
    expect(config).toEqual({
      realtimeUrl: "http://localhost:3121",
      turnstile: { enabled: true, siteKey: TURNSTILE_TEST.siteKey },
      devBots: false,
    });
    const text = JSON.stringify(config);
    for (const secret of [...Object.values(TEST_SECRETS), TURNSTILE_TEST.secretKey, "mongodb://"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("siteKey nur, wenn Turnstile vollständig konfiguriert ist; leere REALTIME_URL bleibt leer", () => {
    expect(publicRuntimeConfigFrom(testEnv({ REALTIME_URL: "" }))).toEqual({
      realtimeUrl: "",
      turnstile: { enabled: false, siteKey: null },
      devBots: false,
    });
    expect(publicRuntimeConfigFrom(testEnv({ TURNSTILE_SITE_KEY: TURNSTILE_TEST.siteKey })).turnstile.siteKey).toBe(
      null,
    );
  });

  it("liefert devBots aus der validierten Env (DEV_BOTS_ENABLED, nur Dev/Test)", () => {
    expect(publicRuntimeConfigFrom(testEnv({ DEV_BOTS_ENABLED: "true" })).devBots).toBe(true);
    expect(publicRuntimeConfigFrom(testEnv({ DEV_BOTS_ENABLED: "false" })).devBots).toBe(false);
  });
});

describe("Logger-Redaction (docs/06 §Logging)", () => {
  it("ersetzt Cookies, Authorization, Tickets, Turnstile-Tokens, URI und IP; guestId nur gehasht", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = createLogger({ level: "info", destination: sink });
    const guestId = "6f1c1c1e-8e1a-4c1e-9a55-1c2d3e4f5a6b";
    logger.info(
      {
        guestId,
        ticket: "eyJ.ticket.sig",
        turnstileToken: "XXXX.DUMMY",
        cookie: "kd_sid=geheim",
        authorization: "Bearer geheim",
        MONGODB_URI: "mongodb://user:pass@db/x",
        ip: "203.0.113.9",
        headers: { cookie: "kd_sid=geheim2", "set-cookie": "kd_sid=geheim3", authorization: "Bearer x" },
        nested: { guestId, secret: "s3cr3t" },
      },
      "Test",
    );
    const text = lines.join("");
    for (const secret of ["eyJ.ticket.sig", "XXXX.DUMMY", "geheim", "Bearer", "user:pass", "203.0.113.9", "s3cr3t"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain(guestId);
    const entry = JSON.parse(lines[0] ?? "{}") as { guestId?: string; nested?: { guestId?: string } };
    expect(entry.guestId).toBe(hashGuestId(guestId));
    expect(entry.nested?.guestId).toMatch(/^g:[0-9a-f]{12}$/);
  });
});

describe("Client-IP und Origin", () => {
  const env = testEnv();
  const trusted = testEnv({ TRUSTED_IP_HEADER: "cf-connecting-ip" });

  it("liest die IP aus TRUSTED_IP_HEADER, sonst Socket-/Remote-Adresse; nie 4xx deswegen", () => {
    const headers = new Headers({ "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "10.0.0.1" });
    expect(resolveRequestIp(headers, "cf-connecting-ip")).toBe("198.51.100.7");
    expect(resolveRequestIp(headers, undefined)).toBe("10.0.0.1");
    expect(resolveRequestIp(new Headers({ "x-forwarded-for": "10.0.0.1" }), "cf-connecting-ip")).toBe("10.0.0.1");
    expect(
      resolveRequestIp(new Headers({ "cf-connecting-ip": "kaputt", "x-forwarded-for": "::1" }), "cf-connecting-ip"),
    ).toBe("::1");
    expect(clientAddress(new Headers(), trusted)).toEqual({ ip: null, key: UNKNOWN_IP_KEY, resolved: false });
  });

  it("bildet den IP-Schlüssel per HMAC (IPv6 als /64) wie Realtime", () => {
    const address = clientAddress(new Headers({ "x-forwarded-for": "2001:db8:1:2:3:4:5:6" }), env);
    expect(address.resolved).toBe(true);
    expect(address.key).toBe(ipKey("2001:db8:1:2::99", TEST_SECRETS.IP_HASH_SECRET));
    expect(address.key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("Origin: nur APP_ORIGIN; fehlend, fremd oder 'null' → 403 (UNAUTHORIZED)", () => {
    expect(() => assertAllowedOrigin(new Headers({ origin: "http://localhost:3120" }), env)).not.toThrow();
    for (const origin of ["https://evil.example.com", "null", "http://localhost:3120/pfad"]) {
      expect(() => assertAllowedOrigin(new Headers({ origin }), env)).toThrow(ApiError);
    }
    try {
      assertAllowedOrigin(new Headers({ "sec-fetch-site": "same-origin" }), env);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(403);
      expect((error as ApiError).code).toBe("UNAUTHORIZED");
    }
  });
});
