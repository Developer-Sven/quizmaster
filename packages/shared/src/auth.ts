/**
 * Gast-Session und Realtime-Tickets (docs/05 §Verbindung, docs/06 §Identität, ADR-006): gemeinsame
 * Konstanten und Schemas, damit Web (stellt aus) und Realtime (prüft) exakt dasselbe erwarten.
 * Die guestId ist GEHEIM – sie steht nur in Cookie/Ticket (`sub`) und in Server-Daten, nie in Payloads.
 */
import { z } from "zod";

/** guestId = `crypto.randomUUID()`. */
export const guestIdSchema = z.uuid();

/** Session-Cookie (HttpOnly; Secure in Produktion; SameSite=Lax; Path=/). */
export const SESSION_COOKIE = {
  name: "kd_sid",
  /** JWT-Laufzeit und Cookie-Max-Age: 180 Tage. */
  maxAgeSec: 180 * 24 * 60 * 60,
  /** Rollierend erneuern, wenn weniger als 30 Tage übrig sind. */
  renewBelowSec: 30 * 24 * 60 * 60,
  sameSite: "lax",
  path: "/",
  algorithm: "HS256",
} as const;

/** Kurzlebiges Socket-Ticket (JWT HS256, 60 s, `jti` wird von Realtime nur einmal akzeptiert). */
export const REALTIME_TICKET = {
  audience: "realtime",
  issuer: "web",
  algorithm: "HS256",
  ttlSec: 60,
} as const;

/** Obergrenze für Ticket-Strings (JWT) in Payloads. */
export const TICKET_MAX_LENGTH = 2_048;

/** Claims des Session-JWT im Cookie `kd_sid` (zusätzliche Standard-Claims werden ignoriert). */
export const sessionClaimsSchema = z.object({
  sub: guestIdSchema,
  exp: z.int(),
  iat: z.int().optional(),
});
export type SessionClaims = z.output<typeof sessionClaimsSchema>;

/**
 * Claims des Realtime-Tickets. `tsv` = Zeitpunkt (ms) einer serverseitig verifizierten Turnstile-Prüfung;
 * nur nötig, wenn `appConfig.turnstileOnJoin` aktiv ist (docs/06 §Turnstile).
 */
export const realtimeTicketClaimsSchema = z.object({
  sub: guestIdSchema,
  aud: z.literal(REALTIME_TICKET.audience),
  iss: z.literal(REALTIME_TICKET.issuer),
  exp: z.int(),
  iat: z.int().optional(),
  jti: z.string().min(16).max(64),
  tsv: z.int().min(0).optional(),
});
export type RealtimeTicketClaims = z.output<typeof realtimeTicketClaimsSchema>;

/** `auth` des Socket.IO-Handshakes: `{ ticket, protocolVersion }` (docs/05 §Verbindung 2). */
export const handshakeAuthSchema = z.strictObject({
  ticket: z.string().min(1).max(TICKET_MAX_LENGTH),
  protocolVersion: z.int().min(0).max(1_000_000),
});
export type HandshakeAuth = z.output<typeof handshakeAuthSchema>;
