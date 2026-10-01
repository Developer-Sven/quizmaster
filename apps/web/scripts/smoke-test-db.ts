/**
 * Manueller End-to-End-Check der Web-Serverseite gegen einen echten `next start` und die Test-Datenbank
 * (ADR-029, nie quizmaster_dev): eigenes Collection-Präfix, Env nur für diese Test-DB mit frischen
 * Zufalls-Secrets, dann Prüfungen per HTTP (Header/CSP, Session, Ticket, Kategorien, Health, Origin-Schutz,
 * Rate-Limit) und ein Blick ins Server-Log (keine Secrets). Räumt danach auf (Präfix droppen).
 *
 * Aufruf (Build vorher in NEXT_DIST_DIR, Standard .next-webapi):
 *   qm-bg start web-smoke <log> -- node apps/web/scripts/smoke-test-db.ts [--port 3120]
 * Gibt nie Secrets, Tokens oder die Datenbank-URI aus.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { decodeJwt, jwtVerify } from "jose";

const webRoot = path.resolve(import.meta.dirname, "..");
const portArg = process.argv.indexOf("--port");
const port = portArg === -1 ? 3120 : Number(process.argv[portArg + 1]);
const origin = `http://127.0.0.1:${port}`;
const realtimeUrl = `http://127.0.0.1:${port + 1}`;
const distDir = process.env.NEXT_DIST_DIR ?? ".next-webapi";

const secrets = {
  SESSION_SECRET: randomBytes(32).toString("base64url"),
  REALTIME_TICKET_SECRET: randomBytes(32).toString("base64url"),
  IP_HASH_SECRET: randomBytes(32).toString("base64url"),
};

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  (${detail})`}`);
}

const serverLog: string[] = [];
let child: ChildProcess | undefined;
let db: TestDatabase | undefined;

async function shutdown(code: number): Promise<never> {
  if (child !== undefined && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8_000);
      child?.once("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
  if (db !== undefined) await db.cleanup();
  process.exit(code);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.info(`${signal} – räume auf …`);
    void shutdown(1);
  });
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.status === 200) return true;
    } catch {
      // Server lauscht noch nicht – weiter warten.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function post(pathname: string, init: { cookie?: string; origin?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: init.origin ?? origin };
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  return fetch(`${origin}${pathname}`, { method: "POST", headers, body: JSON.stringify(init.body ?? {}) });
}

function sessionCookie(response: Response): { value: string; attributes: string } | undefined {
  const line = response.headers.getSetCookie().find((cookie) => cookie.startsWith("kd_sid="));
  if (line === undefined) return undefined;
  const [pair = "", ...attributes] = line.split(";");
  return { value: pair.slice("kd_sid=".length), attributes: attributes.join(";").toLowerCase() };
}

async function main(): Promise<void> {
  db = await createTestDatabase({ ensureIndexes: true });
  console.info(`Test-DB bereit (Quelle ${db.source}, Datenbank ${db.dbName}, Präfix ${db.prefix})`);
  const now = new Date();
  const category = (id: string, order: number, playable: boolean) => ({
    _id: id,
    name: `Smoke ${order}`,
    icon: "book-open",
    color: "#3366FF",
    order,
    description: "Smoke-Test",
    scope: "PRIVAT",
    notScope: "PRIVAT",
    active: true,
    playableCount: playable ? 500 : 0,
    approvedCount: 0,
    playable,
    topics: [{ id: "privat", name: "Privat", target: 1, method: "ki" as const }],
    updatedAt: now,
  });
  await db.collections.categories.insertMany([
    category("b-kat", 2, true),
    category("a-kat", 1, true),
    category("c-kat", 3, false),
  ]);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    NEXT_DIST_DIR: distDir,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    APP_ORIGIN: origin,
    REALTIME_URL: realtimeUrl,
    MONGODB_URI: db.uri,
    MONGODB_DB: db.dbName,
    MONGODB_COLLECTION_PREFIX: db.prefix,
    ...secrets,
    TURNSTILE_ENABLED: "false",
    LOG_LEVEL: "info",
    RATE_LIMIT_MODE: "normal",
  };
  child = spawn(path.join(webRoot, "node_modules/.bin/next"), ["start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: webRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      serverLog.push(text);
      process.stdout.write(text.replace(/^/gm, "[next] "));
    });
  }

  check("Server startet und /api/health antwortet 200", await waitForHealth(60_000));

  // --- Seiten: Header, CSP, Nonce, Cache-Control ---
  const page = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
  const html = await page.text();
  const csp = page.headers.get("content-security-policy") ?? "";
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
  check("GET / → 200", page.status === 200, String(page.status));
  check(
    "CSP mit Nonce + strict-dynamic, ohne unsafe-eval",
    nonce !== undefined && csp.includes("'strict-dynamic'") && !csp.includes("unsafe-eval"),
  );
  check(
    "CSP connect-src mit Realtime-Origin (ws + http) und Turnstile",
    csp.includes(`connect-src 'self' ws://127.0.0.1:${port + 1} ${realtimeUrl} https://challenges.cloudflare.com`),
  );
  check(
    "keine upgrade-insecure-requests/HSTS bei http",
    !csp.includes("upgrade-insecure-requests") && page.headers.get("strict-transport-security") === null,
  );
  const again = await fetch(`${origin}/`, { headers: { accept: "text/html" } });
  check(
    "Nonce pro Request neu",
    /'nonce-([^']+)'/.exec(again.headers.get("content-security-policy") ?? "")?.[1] !== nonce,
  );
  await again.text();
  const expectedHeaders: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    "x-robots-tag": "noindex, nofollow",
  };
  for (const [name, value] of Object.entries(expectedHeaders)) {
    check(`Header ${name}`, page.headers.get(name) === value, page.headers.get(name) ?? "fehlt");
  }
  check("kein X-Powered-By", page.headers.get("x-powered-by") === null);
  check(
    "HTML: Cache-Control no-store + no-transform bleibt erhalten",
    page.headers.get("cache-control") === "private, no-cache, no-store, max-age=0, must-revalidate, no-transform",
    page.headers.get("cache-control") ?? "fehlt",
  );
  const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
  const noncedScripts = scriptTags.filter((tag) => nonce !== undefined && tag.includes(`nonce="${nonce}"`)).length;
  console.info(`INFO  / hat ${scriptTags.length} <script>-Tags, davon ${noncedScripts} mit der Request-Nonce`);

  // --- Session ---
  const created = await post("/api/session");
  const cookie = sessionCookie(created);
  check(
    "POST /api/session → 201 { created: true }",
    created.status === 201 && JSON.stringify(await created.json()) === '{"created":true}',
  );
  check(
    "kd_sid: HttpOnly, SameSite=Lax, Path=/, Max-Age 180 Tage, ohne Secure (http)",
    ["httponly", "samesite=lax", "path=/", "max-age=15552000"].every((part) =>
      (cookie?.attributes ?? "").includes(part),
    ) && !(cookie?.attributes ?? "secure").includes("secure"),
    cookie?.attributes,
  );
  const guestId = cookie === undefined ? "" : String(decodeJwt(cookie.value).sub);
  check("Gast in der Test-DB angelegt", (await db.collections.guests.countDocuments({ _id: guestId })) === 1);
  const reused = await post("/api/session", { cookie: `kd_sid=${cookie?.value ?? ""}` });
  check(
    "Session weiterverwendet → 200 { created: false }, kein neues Cookie",
    reused.status === 200 &&
      JSON.stringify(await reused.json()) === '{"created":false}' &&
      sessionCookie(reused) === undefined,
  );
  const foreign = await post("/api/session", { origin: "https://evil.example.com" });
  check("fremde Origin → 403", foreign.status === 403, JSON.stringify(await foreign.json()));

  // --- Ticket ---
  const ticketResponse = await post("/api/realtime/ticket", { cookie: `kd_sid=${cookie?.value ?? ""}` });
  const ticketBody = (await ticketResponse.json()) as { ticket?: string };
  let ticketOk = false;
  if (ticketResponse.status === 200 && typeof ticketBody.ticket === "string") {
    const { payload } = await jwtVerify(ticketBody.ticket, new TextEncoder().encode(secrets.REALTIME_TICKET_SECRET), {
      algorithms: ["HS256"],
      audience: "realtime",
      issuer: "web",
    });
    ticketOk =
      payload.sub === guestId &&
      typeof payload.exp === "number" &&
      typeof payload.iat === "number" &&
      payload.exp - payload.iat === 60 &&
      /^[A-Za-z0-9_-]{22}$/.test(String(payload.jti));
  }
  check("POST /api/realtime/ticket → gültiges JWT (sub, aud, iss, 60 s, jti)", ticketOk, String(ticketResponse.status));
  check("Ticket-Antwort no-store", ticketResponse.headers.get("cache-control") === "no-store");
  const anonymous = await post("/api/realtime/ticket");
  check("Ticket ohne Cookie → 401", anonymous.status === 401, JSON.stringify(await anonymous.json()));

  // --- Kategorien & Health ---
  const categories = await fetch(`${origin}/api/categories`);
  const categoriesText = await categories.text();
  check("GET /api/categories → 200", categories.status === 200);
  check(
    "Kategorien: Cache-Control public, s-maxage=300, stale-while-revalidate=3600",
    categories.headers.get("cache-control") === "public, s-maxage=300, stale-while-revalidate=3600",
    categories.headers.get("cache-control") ?? "fehlt",
  );
  check(
    "Kategorien: nur spielbare, nur öffentliche Felder, sortiert",
    categoriesText ===
      '{"categories":[{"id":"a-kat","name":"Smoke 1","icon":"book-open","color":"#3366FF","order":1},{"id":"b-kat","name":"Smoke 2","icon":"book-open","color":"#3366FF","order":2}]}',
    categoriesText,
  );
  check(
    "API-CSP default-src 'none'",
    categories.headers.get("content-security-policy") === "default-src 'none'; frame-ancestors 'none'",
  );
  const health = await fetch(`${origin}/api/health`);
  check(
    "GET /api/health → 200 { ok: true }, no-store",
    health.status === 200 &&
      (await health.text()) === '{"ok":true}' &&
      health.headers.get("cache-control") === "no-store",
  );

  // --- Rate-Limit Session (IP 10 / 10 min, Mongo-Store) – zählt nur NEUE Sessions ---
  let reusedOk = true;
  for (let i = 0; i < 12; i++) {
    const response = await post("/api/session", { cookie: `kd_sid=${cookie?.value ?? ""}` });
    reusedOk &&= response.status === 200;
    await response.text();
  }
  check("Weiterverwenden zählt nicht gegen das Anlege-Limit (12× 200)", reusedOk);
  let limited: Response | undefined;
  for (let i = 0; i < 12 && limited === undefined; i++) {
    const response = await post("/api/session");
    if (response.status === 429) limited = response;
    else await response.text();
  }
  const retryAfter = Number(limited?.headers.get("retry-after"));
  check(
    "Session-Limit (neue Gäste) → 429 mit Retry-After",
    limited !== undefined && retryAfter > 0 && retryAfter <= 600,
    `Retry-After ${retryAfter}`,
  );
  const stillReused = await post("/api/session", { cookie: `kd_sid=${cookie?.value ?? ""}` });
  check("Bestehende Session bleibt trotz ausgeschöpftem Anlege-Limit nutzbar", stillReused.status === 200);
  await stillReused.text();
  check(
    "Rate-Limit-Zähler im Mongo-Store (Test-Präfix)",
    (await db.db.collection(`${db.prefix}rateLimits`).countDocuments()) > 0,
  );

  // --- Log ---
  const log = serverLog.join("");
  check("Start-Checks im Server-Log bestanden", log.includes("Start-Checks bestanden"));
  const leaks = [...Object.values(secrets), cookie?.value ?? "§", ticketBody.ticket ?? "§", guestId || "§"].filter(
    (value) => log.includes(value),
  );
  const password = /^mongodb(?:\+srv)?:\/\/[^:@/]+:([^@/]+)@/.exec(db.uri)?.[1];
  check(
    "Server-Log ohne Secrets, Tokens, guestId und DB-Passwort",
    leaks.length === 0 && (password === undefined || !log.includes(password)),
  );
}

main()
  .then(async () => {
    const failed = results.filter((result) => !result.ok);
    console.info(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
    await shutdown(failed.length === 0 ? 0 : 1);
  })
  .catch(async (error: unknown) => {
    console.error("Smoke-Test abgebrochen:", error instanceof Error ? `${error.name}: ${error.message}` : error);
    await shutdown(1);
  });
