/**
 * Gast-Session (Cookie `kd_sid`) und Realtime-Ticket als JWT HS256 (docs/05 §Verbindung, docs/06
 * §Identität, ADR-006). Die guestId steht nur im `sub` – nie in Payloads an andere Clients.
 *
 * Schlüssel-Vertrag mit apps/realtime: Der HMAC-Schlüssel ist die UTF-8-Bytefolge des Secret-Strings
 * (`new TextEncoder().encode(REALTIME_TICKET_SECRET)`), kein Base64-Decode (`hmacKey`).
 */
import { randomBytes } from "node:crypto";
import {
  REALTIME_TICKET,
  type RealtimeTicketClaims,
  realtimeTicketClaimsSchema,
  SESSION_COOKIE,
  type SessionClaims,
  sessionClaimsSchema,
  TICKET_MAX_LENGTH,
} from "@quizmaster/shared";
import { errors, jwtVerify, SignJWT } from "jose";

/** Obergrenze für den Cookie-Wert (ein Session-JWT ist ~200 Zeichen lang). */
export const SESSION_TOKEN_MAX_LENGTH = 2_048;

/** HMAC-Schlüssel aus einem Secret (UTF-8-Bytes des Strings) – identisch in Web und Realtime. */
export function hmacKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export interface SignedSession {
  token: string;
  claims: SessionClaims;
}

/** Session-JWT: `sub = guestId`, `iat`, `exp = iat + 180 Tage`. */
export async function signSessionToken(guestId: string, secret: string, nowSec: number): Promise<SignedSession> {
  const claims = sessionClaimsSchema.parse({ sub: guestId, iat: nowSec, exp: nowSec + SESSION_COOKIE.maxAgeSec });
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: SESSION_COOKIE.algorithm, typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuedAt(nowSec)
    .setExpirationTime(claims.exp)
    .sign(hmacKey(secret));
  return { token, claims };
}

/**
 * Prüft ein Session-JWT (nur HS256, Signatur, `exp`, `sub` als UUID). Ungültig oder abgelaufen → `null`
 * (wie „keine Session“); unerwartete Fehler werden weitergeworfen.
 */
export async function verifySessionToken(token: string, secret: string, nowSec: number): Promise<SessionClaims | null> {
  if (token.length === 0 || token.length > SESSION_TOKEN_MAX_LENGTH) return null;
  try {
    const { payload } = await jwtVerify(token, hmacKey(secret), {
      algorithms: [SESSION_COOKIE.algorithm],
      currentDate: new Date(nowSec * 1_000),
      requiredClaims: ["sub", "exp"],
    });
    const claims = sessionClaimsSchema.safeParse(payload);
    return claims.success ? claims.data : null;
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }
}

/** Rollierend erneuern, wenn weniger als 30 Tage Restlaufzeit bleiben. */
export function needsRenewal(claims: SessionClaims, nowSec: number): boolean {
  return claims.exp - nowSec < SESSION_COOKIE.renewBelowSec;
}

/** Cookie-Attribute: HttpOnly; Secure bei https-APP_ORIGIN (Produktion); SameSite=Lax; Path=/. */
export function sessionCookie(token: string, secure: boolean) {
  return {
    name: SESSION_COOKIE.name,
    value: token,
    httpOnly: true,
    secure,
    sameSite: SESSION_COOKIE.sameSite,
    path: SESSION_COOKIE.path,
    maxAge: SESSION_COOKIE.maxAgeSec,
  } as const;
}

export interface IssueTicketInput {
  guestId: string;
  secret: string;
  nowMs: number;
  /** Zeitpunkt (ms) einer serverseitig verifizierten Turnstile-Prüfung → Claim `tsv`. */
  turnstileVerifiedAt?: number;
}

export interface IssuedTicket {
  ticket: string;
  claims: RealtimeTicketClaims;
}

/** Zufällige Ticket-ID: 128 Bit, base64url (22 Zeichen). */
export function newTicketId(): string {
  return randomBytes(16).toString("base64url");
}

/** Realtime-Ticket: `sub = guestId`, `aud = realtime`, `iss = web`, 60 s, `jti` zufällig, optional `tsv`. */
export async function issueRealtimeTicket(input: IssueTicketInput): Promise<IssuedTicket> {
  const iat = Math.floor(input.nowMs / 1_000);
  const claims = realtimeTicketClaimsSchema.parse({
    sub: input.guestId,
    aud: REALTIME_TICKET.audience,
    iss: REALTIME_TICKET.issuer,
    iat,
    exp: iat + REALTIME_TICKET.ttlSec,
    jti: newTicketId(),
    ...(input.turnstileVerifiedAt === undefined ? {} : { tsv: Math.floor(input.turnstileVerifiedAt) }),
  });
  const ticket = await new SignJWT(claims.tsv === undefined ? {} : { tsv: claims.tsv })
    .setProtectedHeader({ alg: REALTIME_TICKET.algorithm, typ: "JWT" })
    .setSubject(claims.sub)
    .setAudience(claims.aud)
    .setIssuer(claims.iss)
    .setIssuedAt(iat)
    .setExpirationTime(claims.exp)
    .setJti(claims.jti)
    .sign(hmacKey(input.secret));
  if (ticket.length > TICKET_MAX_LENGTH) throw new Error("Ticket zu lang");
  return { ticket, claims };
}
