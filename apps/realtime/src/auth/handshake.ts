/**
 * Handshake-Schutz (docs/05 §Verbindung 3, docs/06 §DDoS 3/5, ADR-028) in zwei Stufen:
 *
 * 1. `allowRequest` (vor der Engine-Sitzung bzw. vor dem WebSocket-Upgrade):
 *    - Origin ∈ APP_ORIGIN; ein fehlender Origin nur mit `Sec-Fetch-Site: same-origin` (ADR-028) → sonst
 *      hart abgelehnt (HTTP 403 bzw. 400 beim Upgrade),
 *    - Handshake-Limit je IP-Schlüssel (60/min), IP- und globale Verbindungsgrenze, Lastabwurf, Shutdown.
 *    Limit-Entscheidungen werden am Request vermerkt und erst in Stufe 2 zugestellt, damit der Client
 *    `connect_error` mit `data.code` bekommt (Vertrag `reject_handshake` in `limits.ts`). Nur eine Flut
 *    (mehr als das Doppelte des Handshake-Limits) wird schon hier hart abgewiesen.
 * 2. Auth-Middleware (`io.use`): vermerkte Ablehnung → `handshakeAuthSchema` → Ticket (jose, `jti` einmalig)
 *    → Ban (Gast + IP-Schlüssel) → `protocolVersion ≥ appConfig.minClientProtocol` → verbindliche
 *    Reservierung der Verbindung (Gast 5, IP 100, global) → `socket.data`.
 *
 * Fehler gehen als `connect_error` mit `data: { code, retryAfterMs? }` (Vertrag `connectErrorDataSchema` aus
 * shared) an den Client (UNAUTHORIZED, UPDATE_REQUIRED, BANNED, TOO_MANY_CONNECTIONS, SERVER_BUSY, RATE_LIMITED);
 * die Meldung enthält nur den Code.
 */
import type { IncomingMessage } from "node:http";
import { type ConnectErrorData, type ErrorCode, handshakeAuthSchema, isAllowedOrigin } from "@quizmaster/shared";
import { ipKey as hashIp, resolveClientIp } from "@quizmaster/shared/ip";
import type { RealtimeEnv } from "../env.ts";
import type { Logger, SecurityLog } from "../logger.ts";
import { guestTag } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import type { AppSocket, Clock, Lifecycle, SocketData } from "../registry/types.ts";
import type { AppConfigService } from "../services/app-config.ts";
import type { BansService } from "../services/bans.ts";
import type { ConnectionsService } from "../services/connections.ts";
import { UNKNOWN_IP_KEY } from "../services/connections.ts";
import type { RateLimitService } from "../services/rate-limit.ts";
import type { TicketVerifier } from "./ticket.ts";

/** Ablehnung mit Protokoll-Code (für `connect_error`). */
export interface HandshakeRejection {
  code: ErrorCode;
  /** Grund für Metrik/Log (fester Wert). */
  reason: string;
  retryAfterMs?: number;
}

/**
 * `data` für `connect_error` nach dem Vertrag `connectErrorDataSchema` (shared): Code und – falls endlich – die
 * Wartezeit als ganze Millisekunden ≥ 0.
 */
export function connectErrorData(rejection: Pick<HandshakeRejection, "code" | "retryAfterMs">): ConnectErrorData {
  const { code, retryAfterMs } = rejection;
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs)) return { code };
  return { code, retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) };
}

/** Fehlerobjekt für `next(err)` – Socket.IO sendet `message` und `data` an den Client. */
export class HandshakeError extends Error {
  readonly data: ConnectErrorData;

  constructor(rejection: HandshakeRejection) {
    super(rejection.code);
    this.name = "HandshakeError";
    this.data = connectErrorData(rejection);
  }
}

/** Was `allowRequest` über einen Handshake-Request weiß. */
interface HandshakeNote {
  ipKey: string | null;
  rejection: HandshakeRejection | null;
}

export interface HandshakeDeps {
  env: RealtimeEnv;
  clock: Clock;
  logger: Logger;
  security: SecurityLog;
  metrics: RealtimeMetrics;
  lifecycle: Lifecycle;
  rateLimit: RateLimitService;
  connections: ConnectionsService;
  bans: BansService;
  appConfig: AppConfigService;
  tickets: TicketVerifier;
}

export type AllowRequest = (
  req: IncomingMessage,
  callback: (err: string | null | undefined, success: boolean) => void,
) => void;
export type SocketMiddleware = (socket: AppSocket, next: (err?: Error) => void) => void;

/** Mehr als das Doppelte des Handshake-Limits gilt als Flut und wird ohne Engine-Sitzung abgewiesen. */
export const HANDSHAKE_FLOOD_FACTOR = 2;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface Handshake {
  allowRequest: AllowRequest;
  middleware: SocketMiddleware;
}

export function createHandshake(deps: HandshakeDeps): Handshake {
  const notes = new WeakMap<IncomingMessage, HandshakeNote>();
  const handshakeRule = deps.rateLimit.rule("socket.handshake.ip");

  const reject = (rejection: HandshakeRejection) => {
    deps.metrics.connectionsRejected.inc({ reason: rejection.reason });
    deps.security.record("handshake_rejected", rejection.reason);
  };

  const clientIpKey = (req: IncomingMessage): string | null => {
    const ip = resolveClientIp(req.headers, deps.env.TRUSTED_IP_HEADER, req.socket.remoteAddress);
    return ip === null ? null : hashIp(ip, deps.env.IP_HASH_SECRET);
  };

  const precheck = async (key: string | null): Promise<HandshakeRejection | "flood" | null> => {
    const decision = await deps.rateLimit.consume(handshakeRule, key ?? UNKNOWN_IP_KEY);
    if (!decision.allowed) {
      deps.metrics.rateLimitHits.inc({ rule: handshakeRule.id });
      deps.security.record("limit_hit", handshakeRule.id);
      if (decision.consumedPoints > handshakeRule.points * HANDSHAKE_FLOOD_FACTOR) return "flood";
      return { code: "RATE_LIMITED", reason: "RATE_LIMITED", retryAfterMs: decision.retryAfterMs };
    }
    if (deps.lifecycle.isShuttingDown()) return { code: "SERVER_BUSY", reason: "shutdown" };
    if (deps.metrics.eventLoop.overloaded()) return { code: "SERVER_BUSY", reason: "overloaded" };
    const limit = deps.connections.precheck(key);
    if (limit !== null) {
      deps.metrics.rateLimitHits.inc({ rule: `connections.${limit.limit}` });
      return { code: limit.code, reason: limit.code };
    }
    return null;
  };

  const allowRequest: AllowRequest = (req, callback) => {
    const origin = headerValue(req.headers.origin);
    const secFetchSite = headerValue(req.headers["sec-fetch-site"]);
    if (!isAllowedOrigin({ origin, secFetchSite }, deps.env.APP_ORIGIN, { allowMissingWhenSameOrigin: true })) {
      reject({ code: "UNAUTHORIZED", reason: "origin" });
      callback("origin not allowed", false);
      return;
    }
    let key: string | null;
    try {
      key = clientIpKey(req);
    } catch (error) {
      deps.logger.error({ err: error }, "IP-Schlüssel nicht bildbar");
      reject({ code: "INTERNAL", reason: "INTERNAL" });
      callback("internal error", false);
      return;
    }
    precheck(key)
      .then(
        (result) => {
          if (result === "flood") {
            reject({ code: "RATE_LIMITED", reason: "flood" });
            callback("too many handshakes", false);
            return;
          }
          notes.set(req, { ipKey: key, rejection: result });
          callback(null, true);
        },
        (error: unknown) => {
          deps.logger.error({ err: error }, "Handshake-Vorprüfung fehlgeschlagen");
          notes.set(req, { ipKey: key, rejection: { code: "SERVER_BUSY", reason: "INTERNAL" } });
          callback(null, true);
        },
      )
      .catch((error: unknown) => {
        deps.logger.error({ err: error }, "Handshake-Vorprüfung: Rückruf fehlgeschlagen");
      });
  };

  /** Stufe 2 bis einschließlich Ban/Protokollversion; die Reservierung folgt synchron in `middleware`. */
  const authenticate = async (socket: AppSocket): Promise<SocketData | HandshakeRejection> => {
    const note = notes.get(socket.request) ?? { ipKey: clientIpKey(socket.request), rejection: null };
    if (note.rejection !== null) return note.rejection;
    if (deps.lifecycle.isShuttingDown()) return { code: "SERVER_BUSY", reason: "shutdown" };

    const auth = handshakeAuthSchema.safeParse(socket.handshake.auth);
    if (!auth.success) return { code: "UNAUTHORIZED", reason: "auth_payload" };

    const now = deps.clock.now();
    const ticket = await deps.tickets.verify(auth.data.ticket, now);
    if (!ticket.ok) {
      if (ticket.reason === "store_full") {
        deps.logger.error("jti-Speicher voll – neue Tickets werden abgelehnt");
        return { code: "SERVER_BUSY", reason: "jti_store_full" };
      }
      return { code: "UNAUTHORIZED", reason: `ticket_${ticket.reason}` };
    }
    const guestId = ticket.claims.sub;

    let banned: boolean;
    try {
      banned = (await deps.bans.findActive({ guestId, ipKey: note.ipKey })) !== null;
    } catch (error) {
      deps.metrics.recordMongoError("ban_lookup");
      deps.logger.warn({ err: error, guest: guestTag(guestId) }, "Ban-Prüfung fehlgeschlagen – Handshake abgelehnt");
      return { code: "SERVER_BUSY", reason: "ban_lookup_failed" };
    }
    if (banned) return { code: "BANNED", reason: "BANNED" };

    if (auth.data.protocolVersion < deps.appConfig.get().minClientProtocol) {
      return { code: "UPDATE_REQUIRED", reason: "UPDATE_REQUIRED" };
    }
    return { guestId, ipKey: note.ipKey, ticketTsv: ticket.claims.tsv ?? null };
  };

  const middleware: SocketMiddleware = (socket, next) => {
    authenticate(socket)
      .then(
        (result) => {
          if (!("guestId" in result)) {
            reject(result);
            next(new HandshakeError(result));
            return;
          }
          // Verbindung inzwischen weg (z. B. während der Ban-Prüfung): nichts reservieren.
          if (socket.conn.readyState !== "open") {
            next(new HandshakeError({ code: "UNAUTHORIZED", reason: "closed" }));
            return;
          }
          const limit = deps.connections.reserve(socket, result);
          if (limit !== null) {
            deps.metrics.rateLimitHits.inc({ rule: `connections.${limit.limit}` });
            const rejection = { code: limit.code, reason: limit.code };
            reject(rejection);
            next(new HandshakeError(rejection));
            return;
          }
          // Freigabe beim Trennen – auch wenn der Socket `connection` nie erreicht (Verbindung vorher zu).
          const release = () => deps.connections.release(socket);
          socket.once("disconnect", release);
          socket.conn.once("close", release);
          socket.data = result;
          next();
        },
        (error: unknown) => {
          deps.logger.error({ err: error }, "Handshake-Prüfung fehlgeschlagen");
          const rejection = { code: "SERVER_BUSY" as const, reason: "INTERNAL" };
          reject(rejection);
          next(new HandshakeError(rejection));
        },
      )
      .catch((error: unknown) => {
        deps.logger.error({ err: error }, "Handshake-Prüfung: Rückruf fehlgeschlagen");
      });
  };

  return { allowRequest, middleware };
}
