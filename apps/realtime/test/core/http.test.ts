/**
 * HTTP neben Socket.IO: `/healthz` (60/min je IP), `/metrics` (Bearer METRICS_TOKEN, 30/min je IP),
 * sonst 404 – Antworten ohne Details, Fehler im Format `{ error: { code, message } }`.
 */
import { healthResponseSchema, httpErrorBodySchema } from "@quizmaster/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tokensEqual } from "../../src/http.ts";
import { startTestServer, type TestServer } from "../helpers/index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({ seed: false });
});
afterAll(() => server?.cleanup());

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("GET /healthz", () => {
  it("antwortet { ok: true } ohne Cache", async () => {
    const response = await server.request("/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(healthResponseSchema.parse(await response.json())).toEqual({ ok: true });
  });

  it("60 je Minute und IP, dann 429 mit Retry-After", async () => {
    const ip = server.nextIp();
    for (let i = 0; i < 60; i++) expect((await server.request("/healthz", { ip })).status).toBe(200);
    const limited = await server.request("/healthz", { ip });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = httpErrorBodySchema.parse(await limited.json());
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
    expect((await server.request("/healthz", { ip: server.nextIp() })).status).toBe(200);
  });
});

describe("GET /metrics", () => {
  it("ohne oder mit falschem Token → 401", async () => {
    for (const headers of [
      {},
      bearer("falsch"),
      bearer(`${server.secrets.metricsToken}x`),
      { authorization: "Basic abc" },
    ]) {
      const response = await server.request("/metrics", { headers });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
      const body = httpErrorBodySchema.parse(await response.json());
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(JSON.stringify(body)).not.toContain(server.secrets.metricsToken);
    }
  });

  it("mit Token → 200 und alle Kernmetriken", async () => {
    const client = await server.connectClient();
    await client.emit("time:sync", { t0: 1 });
    server.app.services.metrics.setActiveLobbies(7);
    server.app.services.metrics.recordChangeStreamRestart("bans", "resume_failed");
    server.app.services.metrics.recordMongoError("test_operation");
    const response = await server.request("/metrics", { headers: bearer(server.secrets.metricsToken) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    for (const name of [
      "qm_sockets",
      "qm_lobbies_active 7",
      'qm_socket_events_total{event="time:sync",outcome="ok"}',
      "qm_ack_latency_seconds_bucket",
      "qm_connections_rejected_total",
      "qm_rate_limit_hits_total",
      "qm_validation_failures_total",
      "qm_violations_total",
      "qm_event_loop_delay_seconds",
      'qm_process_memory_bytes{type="heap_used"}',
      'qm_mongo_errors_total{operation="test_operation"} 1',
      'qm_change_stream_restarts_total{stream="bans",reason="resume_failed"} 1',
      "qm_overloaded",
    ]) {
      expect(text, name).toContain(name);
    }
    expect(text).toMatch(/qm_sockets [1-9]/);
    client.close();
  });

  it("30 je Minute und IP (vor der Token-Prüfung), dann 429", async () => {
    const ip = server.nextIp();
    for (let i = 0; i < 30; i++) expect((await server.request("/metrics", { ip })).status).toBe(401);
    const limited = await server.request("/metrics", { ip, headers: bearer(server.secrets.metricsToken) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});

describe("andere Pfade", () => {
  it("→ 404 ohne Details", async () => {
    for (const path of ["/", "/metricsx", "/healthz/", "/api/session", "/socket.io"]) {
      const response = await server.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.text()).toBe("Not Found");
    }
    const post = await server.request("/healthz", { method: "POST" });
    expect(post.status).toBe(404);
  });

  it("Token-Vergleich ist exakt", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abd")).toBe(false);
    expect(tokensEqual("abc", "abcd")).toBe(false);
    expect(tokensEqual("", "abc")).toBe(false);
  });
});
