/**
 * Realtime-Tickets für Tests – gleiche Form wie `apps/web` (JWT HS256, `aud = realtime`, `iss = web`,
 * 60 s, `jti`, optional `tsv`), Schlüssel = UTF-8-Bytes des Secrets. Über die Optionen lassen sich gezielt
 * ungültige Tickets bauen (falsches Secret, abgelaufen, falsche Audience, `alg: none` …).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { REALTIME_TICKET } from "@quizmaster/shared";
import { type JWTPayload, SignJWT, UnsecuredJWT } from "jose";

export interface MintTicketOptions {
  /** HMAC-Secret; beim Test-Server standardmäßig dessen `REALTIME_TICKET_SECRET`. */
  secret?: string;
  /** Ausstellungszeitpunkt in ms (Standard `Date.now()`). */
  nowMs?: number;
  /** Laufzeit in Sekunden (Standard 60; negativ = bereits abgelaufen). */
  expiresInSec?: number;
  /** Ticket-ID (Standard: zufällig, 22 Zeichen base64url). */
  jti?: string;
  /** Turnstile-Zeitpunkt (ms) → Claim `tsv`. */
  tsv?: number;
  audience?: string;
  issuer?: string;
  /** Algorithmus (Standard HS256; `none` = unsigniertes JWT). */
  algorithm?: "HS256" | "HS512" | "none";
  /** Claims weglassen. */
  omit?: ReadonlyArray<"sub" | "exp" | "jti" | "aud" | "iss" | "iat">;
  /** Zusätzliche Claims. */
  extraClaims?: Record<string, unknown>;
}

export function newTicketId(): string {
  return randomBytes(16).toString("base64url");
}

/** Signiert ein Ticket für `guestId` (Standard: zufällige UUID). */
export async function mintTicket(guestId: string = randomUUID(), options: MintTicketOptions = {}): Promise<string> {
  const secret = options.secret;
  if (secret === undefined && options.algorithm !== "none") throw new Error("mintTicket: secret fehlt");
  const iat = Math.floor((options.nowMs ?? Date.now()) / 1_000);
  const omit = new Set(options.omit ?? []);
  const claims: JWTPayload = { ...options.extraClaims };
  if (!omit.has("sub")) claims.sub = guestId;
  if (!omit.has("aud")) claims.aud = options.audience ?? REALTIME_TICKET.audience;
  if (!omit.has("iss")) claims.iss = options.issuer ?? REALTIME_TICKET.issuer;
  if (!omit.has("iat")) claims.iat = iat;
  if (!omit.has("exp")) claims.exp = iat + (options.expiresInSec ?? REALTIME_TICKET.ttlSec);
  if (!omit.has("jti")) claims.jti = options.jti ?? newTicketId();
  if (options.tsv !== undefined) claims.tsv = options.tsv;

  if (options.algorithm === "none") return new UnsecuredJWT(claims).encode();
  const algorithm = options.algorithm ?? REALTIME_TICKET.algorithm;
  return new SignJWT(claims).setProtectedHeader({ alg: algorithm, typ: "JWT" }).sign(new TextEncoder().encode(secret));
}
