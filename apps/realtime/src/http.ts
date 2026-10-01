/**
 * HTTP-Endpunkte des Realtime-Servers neben Socket.IO (docs/06 §Rate-Limits, docs/12 §Monitoring):
 * - `GET /healthz` → `{ ok: true }` (im Shutdown 503 `{ ok: false }`), 60/min je IP, `Cache-Control: no-store`.
 * - `GET /metrics` → Prometheus-Text; 30/min je IP, dann `Authorization: Bearer <METRICS_TOKEN>`
 *   (konstantzeitiger Vergleich) → sonst 401. Öffentlich nicht geroutet (Caddy: `/metrics` → 404).
 * - alles andere → 404. `/socket.io/*` fängt Socket.IO vorher ab.
 * Fehler gehen nie roh an den Client (`{ error: { code, message } }` wie bei der Web-API).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ackError,
  type ErrorCode,
  type HealthResponse,
  type HttpErrorBody,
  type RateLimitRule,
} from "@quizmaster/shared";
import { ipKey as hashIp, resolveClientIp } from "@quizmaster/shared/ip";
import type { RealtimeEnv } from "./env.ts";
import type { Logger, SecurityLog } from "./logger.ts";
import type { RealtimeMetrics } from "./metrics.ts";
import type { Lifecycle } from "./registry/types.ts";
import { UNKNOWN_IP_KEY } from "./services/connections.ts";
import type { RateLimitService } from "./services/rate-limit.ts";

export interface HttpHandlerDeps {
  env: RealtimeEnv;
  logger: Logger;
  metrics: RealtimeMetrics;
  security: SecurityLog;
  rateLimit: RateLimitService;
  lifecycle: Lifecycle;
}

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function sendError(
  res: ServerResponse,
  status: number,
  code: ErrorCode,
  message: string,
  options: { retryAfterMs?: number; headers?: Record<string, string> } = {},
): void {
  const body: HttpErrorBody = { error: ackError(code, message, options.retryAfterMs).error };
  sendJson(res, status, body, options.headers);
}

/** SHA-256 beider Seiten, dann `timingSafeEqual` – gleich lange Puffer, keine Längen-Seitenkanäle. */
export function tokensEqual(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** `Bearer <token>` aus dem Authorization-Header oder `null`. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s]+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

export function createHttpHandler(deps: HttpHandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const healthRule = deps.rateLimit.rule("http.healthz.ip");
  const metricsRule = deps.rateLimit.rule("http.metrics.ip");

  const clientKey = (req: IncomingMessage): string => {
    const ip = resolveClientIp(req.headers, deps.env.TRUSTED_IP_HEADER, req.socket.remoteAddress);
    return (ip === null ? null : hashIp(ip, deps.env.IP_HASH_SECRET)) ?? UNKNOWN_IP_KEY;
  };

  /** true = weiter; false = 429 gesendet. */
  const withinLimit = async (req: IncomingMessage, res: ServerResponse, rule: RateLimitRule): Promise<boolean> => {
    const decision = await deps.rateLimit.consume(rule, clientKey(req));
    if (decision.allowed) return true;
    deps.metrics.rateLimitHits.inc({ rule: rule.id });
    deps.security.record("limit_hit", rule.id);
    sendError(res, 429, "RATE_LIMITED", "Zu viele Anfragen", {
      retryAfterMs: decision.retryAfterMs,
      headers: { "retry-after": String(Math.max(1, Math.ceil(decision.retryAfterMs / 1_000))) },
    });
    return false;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?", 1)[0];
    if (req.method !== "GET" || (path !== "/healthz" && path !== "/metrics")) {
      res.writeHead(404, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    if (path === "/healthz") {
      if (!(await withinLimit(req, res, healthRule))) return;
      const shuttingDown = deps.lifecycle.isShuttingDown();
      const body: HealthResponse = { ok: !shuttingDown };
      sendJson(res, shuttingDown ? 503 : 200, body);
      return;
    }
    if (!(await withinLimit(req, res, metricsRule))) return;
    const token = bearerToken(req);
    if (token === null || !tokensEqual(token, deps.env.METRICS_TOKEN)) {
      deps.security.record("http_rejected", "metrics_unauthorized");
      sendError(res, 401, "UNAUTHORIZED", "Token fehlt oder ist falsch", {
        headers: { "www-authenticate": 'Bearer realm="metrics"' },
      });
      return;
    }
    const text = await deps.metrics.render();
    res.writeHead(200, { ...BASE_HEADERS, "content-type": deps.metrics.contentType });
    res.end(text);
  };

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      deps.logger.error({ err: error }, "HTTP-Anfrage fehlgeschlagen");
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, 500, "INTERNAL", "Interner Fehler");
    });
  };
}
