/**
 * Gast-Session und Realtime-Tickets (docs/05 §Verbindung, docs/06 §Identität, ADR-006): gemeinsame
 * Konstanten und Schemas, damit Web (stellt aus) und Realtime (prüft) exakt dasselbe erwarten.
 * Die guestId ist GEHEIM – sie steht nur in Cookie/Ticket (`sub`) und in Server-Daten, nie in Payloads.
 */

import { errorCodeSchema } from "./errors.ts";
import * as z from "./zod.ts";

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

/**
 * HMAC-Schlüssel aus einem Secret-String: die UTF-8-Bytes des Strings (`TextEncoder`), KEIN Base64-Decode.
 * Schlüssel-Vertrag zwischen Web (signiert Ticket und Session-Cookie) und Realtime (prüft das Ticket mit
 * `REALTIME_TICKET_SECRET`) – beide Seiten bilden den Schlüssel nur hierüber. Ein leeres Secret wirft
 * (fail closed; die Env-Prüfung verlangt ohnehin ≥ 32 Zeichen).
 */
export function hmacKeyFromSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (secret.length === 0) throw new Error("HMAC-Secret ist leer");
  return new TextEncoder().encode(secret);
}

/** Prüfoptionen für das Realtime-Ticket (Form von jose `JWTVerifyOptions`, ohne Abhängigkeit von jose). */
export interface RealtimeTicketVerifyOptions {
  algorithms: string[];
  audience: string;
  issuer: string;
  requiredClaims: string[];
}

/**
 * Prüfoptionen des Realtime-Tickets (docs/05 §Verbindung 3): nur `HS256`, `aud = realtime`, `iss = web`,
 * Pflicht-Claims `sub`, `exp`, `jti`. Fabrik – jeder Aufruf liefert frische, veränderbare Arrays.
 */
export function realtimeTicketVerifyOptions(): RealtimeTicketVerifyOptions {
  return {
    algorithms: [REALTIME_TICKET.algorithm],
    audience: REALTIME_TICKET.audience,
    issuer: REALTIME_TICKET.issuer,
    requiredClaims: ["sub", "exp", "jti"],
  };
}

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

/**
 * `data` eines abgelehnten Handshakes (`connect_error`, docs/05 §Verbindung 3): `{ code, retryAfterMs? }` –
 * UNAUTHORIZED, UPDATE_REQUIRED, BANNED, TOO_MANY_CONNECTIONS, SERVER_BUSY, RATE_LIMITED (mit `retryAfterMs`).
 * Eine Ablehnung ohne `data` (fremde Origin, Flut) ist ein Transportfehler ohne Code.
 */
export const connectErrorDataSchema = z.strictObject({
  code: errorCodeSchema,
  retryAfterMs: z.int().min(0).optional(),
});
export type ConnectErrorData = z.output<typeof connectErrorDataSchema>;
