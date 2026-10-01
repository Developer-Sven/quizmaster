import { describe, expect, it } from "vitest";
import { OFFLINE_URL, RULES_URL, SKIP_WAITING, SW_DEV_PARAM, SW_SCOPE, SW_URL } from "./protocol";
import {
  CACHE_LIMITS,
  CACHE_NAMES,
  classifyRequest,
  extractStaticAssetUrls,
  isCachedRoute,
  isNeverCached,
  isNextStatic,
  isRulesPage,
  isStaticAsset,
  NAVIGATION_TIMEOUT_SECONDS,
  OFFLINE_ASSET_LIMIT,
  outdatedCaches,
  type RequestFacts,
} from "./routes";

const ORIGIN = "https://quizmaster.example";

function facts(path: string, overrides: Partial<Omit<RequestFacts, "url">> = {}): RequestFacts {
  return { url: new URL(path, ORIGIN), method: "GET", mode: "no-cors", sameOrigin: true, ...overrides };
}

describe("SW-Routing (docs/10 Strategien)", () => {
  it("cacht /api/* und /socket.io/* nie – auch nicht als Navigation oder mit Dateiendung", () => {
    for (const path of [
      "/api",
      "/api/session",
      "/api/realtime/ticket",
      "/api/categories",
      "/api/health?x=1",
      "/socket.io",
      "/socket.io/?EIO=4&transport=polling&t=abc",
      "/api/icons/x.png",
    ]) {
      expect(classifyRequest(facts(path)), path).toBe("never-cache");
      expect(classifyRequest(facts(path, { mode: "navigate" })), path).toBe("never-cache");
      expect(isCachedRoute(classifyRequest(facts(path))), path).toBe(false);
    }
    // Nur exakte Segmente: /apiary ist eine (unbekannte) Seite, keine API
    expect(isNeverCached("/apiary")).toBe(false);
    expect(isNeverCached("/socket.iox")).toBe(false);
  });

  it("behandelt Navigationen mit NetworkFirst (3 s) – Startseite, PWA-Start, Lobby, Beitreten, Offline", () => {
    for (const path of ["/", "/?source=pwa", "/?action=join", "/lobby/ABC234", "/j/ABC234", OFFLINE_URL]) {
      expect(classifyRequest(facts(path, { mode: "navigate" })), path).toBe("navigation");
    }
    expect(NAVIGATION_TIMEOUT_SECONDS).toBe(3);
  });

  it("hält die Regeln-Seite (Link der Offline-Seite) in einem eigenen Cache – nur genau /regeln als Navigation", () => {
    expect(classifyRequest(facts(RULES_URL, { mode: "navigate" }))).toBe("rules");
    expect(classifyRequest(facts(RULES_URL, { mode: "navigate" }), { dev: true })).toBe("rules");
    expect(isCachedRoute("rules")).toBe(true);
    expect(isRulesPage(new URL(RULES_URL, ORIGIN))).toBe(true);
    // Andere Schreibweisen laufen über den Seiten-Cache – der Regeln-Cache hält nie mehr als einen Eintrag.
    for (const path of ["/regeln?utm_source=x", "/regeln/", "/regeln/x", "/regelnx"]) {
      expect(classifyRequest(facts(path, { mode: "navigate" })), path).toBe("navigation");
      expect(isRulesPage(new URL(path, ORIGIN)), path).toBe(false);
    }
    // RSC-Abrufe (Client-Navigation), POST und fremde Origins beantwortet der SW nicht.
    expect(classifyRequest(facts(`${RULES_URL}?_rsc=1x2y3`))).toBe("network");
    expect(classifyRequest(facts(RULES_URL))).toBe("network");
    expect(classifyRequest(facts(RULES_URL, { method: "POST", mode: "navigate" }))).toBe("network");
    expect(classifyRequest(facts(RULES_URL, { mode: "navigate", sameOrigin: false }))).toBe("network");
  });

  it("cacht /_next/static/* mit CacheFirst (300 Einträge, 30 Tage)", () => {
    for (const path of [
      "/_next/static/chunks/main-app-0a1b2c.js",
      "/_next/static/css/1f2e3d.css",
      "/_next/static/media/rubik-latin.0a1b.woff2",
    ]) {
      expect(classifyRequest(facts(path)), path).toBe("next-static");
    }
    expect(isNextStatic("/_next/image")).toBe(false);
    expect(CACHE_LIMITS.nextStatic).toEqual({ maxEntries: 300, maxAgeSeconds: 30 * 24 * 60 * 60 });
  });

  it("cacht Schriften, Icons, Sounds und Flaggen mit CacheFirst (200 Einträge, 60 Tage)", () => {
    for (const path of [
      "/icons/icon-192.png",
      "/icons/favicon.ico",
      "/sounds/lock.webm",
      "/sounds/correct.mp3",
      "/flags/de.svg",
      "/fonts/extra.woff2",
    ]) {
      expect(classifyRequest(facts(path)), path).toBe("static-asset");
    }
    expect(isStaticAsset("/screenshots/lobby.png")).toBe(false);
    expect(CACHE_LIMITS.assets).toEqual({ maxEntries: 200, maxAgeSeconds: 60 * 24 * 60 * 60 });
  });

  it("lässt alles andere unbeantwortet (NetworkOnly): RSC, Bilder-API, Manifest, POST, fremde Origins", () => {
    const network: RequestFacts[] = [
      facts("/lobby/ABC234?_rsc=1x2y3"),
      facts("/_next/image?url=%2Fx.png&w=64&q=75"),
      facts("/manifest.webmanifest"),
      facts(SW_URL),
      facts("/robots.txt"),
      facts("/screenshots/frage.png"),
      facts("/api/session", { method: "POST" }),
      facts("/", { method: "POST", mode: "navigate" }),
      facts("/_next/static/chunks/x.js", { sameOrigin: false }),
      facts("/", { sameOrigin: false, mode: "navigate" }),
    ];
    for (const request of network) {
      expect(classifyRequest(request), `${request.method} ${request.url.href}`).toBe("network");
      expect(isCachedRoute(classifyRequest(request))).toBe(false);
    }
  });

  it("cacht im Dev-Modus (Flag) keine Next-Dateien, Navigationen und Assets aber wie in Produktion", () => {
    expect(classifyRequest(facts("/_next/static/chunks/x.js"), { dev: true })).toBe("network");
    expect(classifyRequest(facts("/", { mode: "navigate" }), { dev: true })).toBe("navigation");
    expect(classifyRequest(facts("/flags/de.svg"), { dev: true })).toBe("static-asset");
  });

  it("hat eindeutige, versionierte Cache-Namen mit eigenem Präfix", () => {
    const names = Object.values(CACHE_NAMES);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^qm-[a-z-]+-v\d+$/);
  });
});

describe("Offline-Seite vorwärmen", () => {
  it("findet Skripte, CSS, Schriften und Chunks aus dem RSC-Payload – ohne Duplikate und Escapes", () => {
    const html = [
      '<link rel="stylesheet" href="/_next/static/css/a1b2.css" data-precedence="next"/>',
      '<link rel="preload" href="/_next/static/media/rubik.p.woff2" as="font" crossorigin="" type="font/woff2"/>',
      '<script src="/_next/static/chunks/webpack-1a2b.js" async="" nonce="abc"></script>',
      '<script src="/_next/static/chunks/webpack-1a2b.js" async=""></script>',
      '<script nonce="abc">self.__next_f.push([1,"3:I[\\"/_next/static/chunks/app/offline/page-9z8y.js\\"]"])</script>',
      '<img src="/icons/icon.svg"/><a href="https://cdn.example/_next/static/evil.js"></a>',
    ].join("");
    expect(extractStaticAssetUrls(html)).toEqual([
      "/_next/static/css/a1b2.css",
      "/_next/static/media/rubik.p.woff2",
      "/_next/static/chunks/webpack-1a2b.js",
      "/_next/static/chunks/app/offline/page-9z8y.js",
      "/_next/static/evil.js",
    ]);
  });

  it("übernimmt nur Pfade (die Origin ist immer die eigene) und begrenzt die Anzahl", () => {
    const many = Array.from({ length: 100 }, (_, index) => `<script src="/_next/static/chunks/${index}.js"></script>`);
    expect(extractStaticAssetUrls(many.join(""))).toHaveLength(OFFLINE_ASSET_LIMIT);
    expect(extractStaticAssetUrls('<script src="/_next/static/../../api/session"></script>')).toEqual([]);
    for (const url of extractStaticAssetUrls('<a href="https://cdn.example/_next/static/x.js">')) {
      expect(new URL(url, ORIGIN).origin).toBe(ORIGIN);
    }
  });
});

describe("Aufräumen beim Aktivieren", () => {
  it("löscht nur eigene, veraltete Caches (den aktuellen Precache nie)", () => {
    const names = [
      CACHE_NAMES.precache,
      CACHE_NAMES.nextStatic,
      CACHE_NAMES.pages,
      CACHE_NAMES.rules,
      "qm-next-static-v0",
      "qm-pages-v0",
      "qm-rules-v0",
      `serwist-precache-v2-${ORIGIN}/`,
      "other-app-cache",
      "workbox-runtime",
    ];
    expect(outdatedCaches(names, Object.values(CACHE_NAMES))).toEqual([
      "qm-next-static-v0",
      "qm-pages-v0",
      "qm-rules-v0",
    ]);
  });
});

describe("Gemeinsame SW-Konstanten", () => {
  it("passen zu next.config.ts (/sw.js-Header), serwist (SKIP_WAITING) und der Offline-Route", () => {
    expect(SW_URL).toBe("/sw.js");
    expect(SW_SCOPE).toBe("/");
    expect(OFFLINE_URL).toBe("/offline");
    expect(RULES_URL).toBe("/regeln");
    expect(SKIP_WAITING).toBe("SKIP_WAITING");
    expect(SW_DEV_PARAM).toMatch(/^[a-z]+$/);
  });
});
