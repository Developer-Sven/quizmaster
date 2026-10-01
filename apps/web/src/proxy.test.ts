/**
 * Wer läuft durch den Proxy (proxy.ts, `config.matcher`) und welche Cache-Header tragen Service Worker und
 * statische Dateien (next.config.ts): HTML-Seiten bekommen weiter die Nonce-CSP (ADR-008), statische Dateien
 * (Sounds, Icons, Schriften, Lizenztexte …) nicht – sie brauchen keine Nonce. `/sw.js` mit `no-cache` (ADR-036),
 * Dateien aus `public/` ohne Hash im Namen eine Woche frisch plus einen Tag `stale-while-revalidate`.
 */
import type { NextConfig } from "next";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import { clearWebEnvCache } from "./env";
import { testEnvSource } from "./lib/server/test-support";
import { config, proxy } from "./proxy";

const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url, nextConfig: nextConfig as NextConfig });

describe("Proxy-Matcher", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearWebEnvCache();
  });

  it("lässt Sounds (webm/mp3), Schriften, Medien und Lizenztexte aus public/ am Proxy vorbei", () => {
    for (const asset of [
      "/sounds/lock.webm",
      "/sounds/correct.mp3",
      "/sounds/LICENSE.md",
      "/fonts/extra.ttf",
      "/fonts/extra.otf",
      "/fonts/extra.woff2",
      "/media/clip.ogg",
      "/media/clip.wav",
      "/media/clip.m4a",
      "/media/clip.mp4",
      "/files/rules.pdf",
      "/icons/icon-192.png",
      "/icons/favicon.svg",
      "/icons/favicon.ico",
      "/screenshots/lobby.png",
      "/flags/de.svg",
      "/flags/LICENSE",
      "/sw.js",
      "/manifest.webmanifest",
      "/robots.txt",
    ]) {
      expect(matches(asset), asset).toBe(false);
    }
  });

  it("schickt jede Seite weiter durch den Proxy – auch Pfade, die nur wie eine Endung aussehen", () => {
    for (const page of [
      "/",
      "/?source=pwa",
      "/lobby/ABC234",
      "/j/ABC234",
      "/regeln",
      "/offline",
      "/sounds",
      "/lobby/webm",
      "/j/MP3ABC",
      "/regeln?x=a.webm",
    ]) {
      expect(matches(page), page).toBe(true);
    }
  });

  it("gibt HTML-Seiten weiter eine frische Nonce in CSP-Antwortheader und Request-Header", () => {
    clearWebEnvCache();
    for (const [key, value] of Object.entries(testEnvSource())) vi.stubEnv(key, value);
    const request = () =>
      proxy(new NextRequest("http://localhost:3120/lobby/ABC234", { headers: { accept: "text/html,*/*;q=0.8" } }));
    const first = request();
    const second = request();
    const nonce = first.headers.get("x-middleware-request-x-nonce");
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(first.headers.get("content-security-policy")).toContain(`'nonce-${nonce}' 'strict-dynamic'`);
    expect(second.headers.get("x-middleware-request-x-nonce")).not.toBe(nonce);
  });
});

describe("Cache-Header für Service Worker und statische Dateien (next.config.ts)", () => {
  const headersFor = async (source: string) => {
    const rules = (await nextConfig.headers?.()) ?? [];
    return Object.fromEntries(
      (rules.find((rule) => rule.source === source)?.headers ?? []).map((header) => [header.key, header.value]),
    );
  };

  it("/sw.js: Cache-Control no-cache (ADR-036) – nie ungeprüft aus einem Cache, ETag → 304 bleibt möglich", async () => {
    expect(await headersFor("/sw.js")).toEqual({
      "Cache-Control": "no-cache",
      "Content-Type": "application/javascript; charset=utf-8",
    });
  });

  it("Flaggen, Sounds, Icons und Screenshots: eine Woche frisch, danach ein Tag stale-while-revalidate", async () => {
    for (const dir of ["flags", "sounds", "icons", "screenshots"]) {
      expect(await headersFor(`/${dir}/:path*`), dir).toEqual({
        "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
      });
    }
  });

  it("setzt Cache-Control sonst nur für Service Worker und Manifest (keine Regel für Seiten oder die API)", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const withCacheControl = rules
      .filter((rule) => rule.headers.some((header) => header.key.toLowerCase() === "cache-control"))
      .map((rule) => rule.source);
    expect(withCacheControl).toEqual([
      "/sw.js",
      "/manifest.webmanifest",
      "/flags/:path*",
      "/sounds/:path*",
      "/icons/:path*",
      "/screenshots/:path*",
    ]);
  });
});
