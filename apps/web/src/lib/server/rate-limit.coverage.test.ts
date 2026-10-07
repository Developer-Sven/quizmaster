/**
 * Invariante 6 für die Web-API (docs/06, docs/11 §Sicherheits-Invarianten 6): JEDE Route unter `src/app/api/**`
 * ist ein Endpunkt aus `WEB_ENDPOINTS`/`HTTP_ENDPOINTS` mit Limit in `RATE_LIMITS` – eine neue Route ohne Limit
 * lässt diesen Test scheitern. Dazu je Endpunkt eine Flut über das echte Route-Modul (Prozess-Env, Test-DB) bis
 * zur Grenze der strengsten Regel → 429 mit `Retry-After`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { closeMongoClient } from "@quizmaster/db";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { HTTP_ENDPOINTS, type HttpEndpoint, RATE_LIMITS } from "@quizmaster/shared";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clearWebEnvCache } from "../../env";
import { getServerContext } from "./context";
import { WEB_ENDPOINTS } from "./rate-limit";
import { sessionCookieOf, testEnvSource, testRequest } from "./test-support";

const API_DIR = fileURLToPath(new URL("../../app/api/", import.meta.url));

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

/** `POST /api/session` usw. aus Verzeichnis und exportierten Methoden einer Route-Datei. */
function endpointsOf(file: string): { declared: string[]; wired: string[] } {
  const path = `/api/${relative(API_DIR, file).split(sep).slice(0, -1).join("/")}`;
  const source = readFileSync(file, "utf8");
  const methods = [...source.matchAll(/export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)];
  const wired = [...source.matchAll(/apiRoute\(\s*"([A-Z]+ \/[^"]+)"/g)].map((match) => match[1] ?? "");
  return { declared: methods.map((match) => `${match[1]} ${path}`), wired };
}

const rulesFor = (endpoint: string) => RATE_LIMITS.filter((rule) => rule.target === endpoint && rule.kind === "rate");

describe("Invariante 6 – jede Web-Route hat ein Limit", () => {
  it("jede Route-Datei unter app/api ist ein bekannter Endpunkt mit Limit (429 + Retry-After)", () => {
    const files = routeFiles(API_DIR);
    expect(files.length).toBeGreaterThanOrEqual(4);
    const found = new Set<string>();
    for (const file of files) {
      const { declared, wired } = endpointsOf(file);
      expect(declared.length, file).toBeGreaterThan(0);
      // Jede exportierte Methode läuft über apiRoute mit genau ihrem Endpunkt (Limit + Fehlerformat).
      expect([...wired].sort(), file).toEqual([...declared].sort());
      for (const endpoint of declared) {
        found.add(endpoint);
        expect(WEB_ENDPOINTS as readonly string[], endpoint).toContain(endpoint);
        const rules = rulesFor(endpoint);
        expect(rules.length, endpoint).toBeGreaterThan(0);
        for (const rule of rules) {
          expect(rule.onExceed).toEqual({ action: "http_error", status: 429, retryAfterHeader: true });
        }
      }
    }
    expect([...found].sort()).toEqual([...WEB_ENDPOINTS].sort());
  });

  it("Web- und Realtime-Endpunkte decken HTTP_ENDPOINTS vollständig ab", () => {
    const realtime: HttpEndpoint[] = ["GET /healthz", "GET /metrics"];
    expect([...WEB_ENDPOINTS, ...realtime].sort()).toEqual([...HTTP_ENDPOINTS].sort());
  });
});

describe("Flut je Web-Endpunkt über das echte Route-Modul", () => {
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

  let ipCounter = 0;
  const freshIp = () => `198.51.100.${++ipCounter}`;

  async function flood(
    endpoint: (typeof WEB_ENDPOINTS)[number],
    call: (request: NextRequest) => Promise<Response>,
    request: () => NextRequest,
  ): Promise<void> {
    const strictest = Math.min(...rulesFor(endpoint).map((rule) => rule.points));
    for (let i = 0; i < strictest; i++) {
      const response = await call(request());
      expect(response.status, `${endpoint} #${i + 1}`).not.toBe(429);
    }
    const limited = await call(request());
    expect(limited.status, endpoint).toBe(429);
    expect(Number(limited.headers.get("retry-after")), endpoint).toBeGreaterThan(0);
    expect(limited.headers.get("cache-control")).toContain("no-store");
    const body = (await limited.json()) as { error?: { code: string }; ok?: boolean };
    // Health antwortet auch bei 429 nur mit `{ ok: false }` (keine Details, docs/06).
    if (endpoint === "GET /api/health") expect(body).toEqual({ ok: false });
    else expect(body.error?.code).toBe("RATE_LIMITED");
  }

  it("POST /api/session (IP 30 / 10 min, neue Sessions)", async () => {
    const { POST } = await import("../../app/api/session/route");
    const ip = freshIp();
    await flood("POST /api/session", POST, () => testRequest("/api/session", { body: {}, ip }));
  });

  it("POST /api/realtime/ticket (Gast 30 / min)", async () => {
    const session = await import("../../app/api/session/route");
    const { POST } = await import("../../app/api/realtime/ticket/route");
    const created = await session.POST(testRequest("/api/session", { body: {}, ip: freshIp() }));
    const cookie = `kd_sid=${sessionCookieOf(created) ?? ""}`;
    await flood("POST /api/realtime/ticket", POST, () =>
      testRequest("/api/realtime/ticket", { body: {}, cookie, ip: freshIp() }),
    );
  });

  it("GET /api/categories (IP 60 / min)", async () => {
    const { GET } = await import("../../app/api/categories/route");
    const ip = freshIp();
    await flood("GET /api/categories", GET, () => testRequest("/api/categories", { method: "GET", origin: null, ip }));
  });

  it("GET /api/health (IP 60 / min)", async () => {
    const { GET } = await import("../../app/api/health/route");
    const ip = freshIp();
    await flood("GET /api/health", GET, () => testRequest("/api/health", { method: "GET", origin: null, ip }));
  });
});
