/**
 * Prüfung des Realtime-Tickets (docs/05 §Verbindung 3, docs/06 §Identität, ADR-006): JWT HS256 mit
 * `aud = realtime`, `iss = web`, `exp` (60 s) und `jti`, das nur EINMAL akzeptiert wird.
 *
 * Schlüssel-Vertrag mit apps/web: HMAC-Schlüssel = UTF-8-Bytes des Strings `REALTIME_TICKET_SECRET`
 * (`new TextEncoder().encode(secret)`), kein Base64-Decode.
 *
 * Der jti-Speicher merkt sich jede verbrauchte Ticket-ID bis zum Ablauf des Tickets (+ Uhren-Toleranz) –
 * also mindestens so lange, wie das Ticket überhaupt gültig sein kann. Er ist nach oben begrenzt; ist er
 * voll, werden neue Tickets abgelehnt (fail-closed), bis abgelaufene Einträge weggeräumt sind.
 */

import type { webcrypto } from "node:crypto";
import {
  REALTIME_TICKET,
  type RealtimeTicketClaims,
  realtimeTicketClaimsSchema,
  TICKET_MAX_LENGTH,
} from "@quizmaster/shared";
import { errors, jwtVerify } from "jose";

/** Toleranz für Uhrabweichungen zwischen Web und Realtime (Sekunden). */
export const TICKET_CLOCK_TOLERANCE_SEC = 5;
/** Obergrenze des jti-Speichers (≈ 20 MB); mehr gültige Tickets pro Minute sind ein Angriff. */
export const JTI_STORE_MAX_ENTRIES = 200_000;
/** Aufräumintervall des jti-Speichers. */
export const JTI_SWEEP_INTERVAL_MS = 30_000;

export type TicketFailure = "invalid" | "expired" | "replayed" | "store_full";

export type TicketResult = { ok: true; claims: RealtimeTicketClaims } | { ok: false; reason: TicketFailure };

/** Einmal-Speicher für Ticket-IDs mit Ablaufzeit. */
export interface JtiStore {
  /** true = erstmalig (jetzt als verbraucht gemerkt), false = bereits verwendet. */
  claim(jti: string, keepUntilMs: number, now: number): boolean | "full";
  size(): number;
  sweep(now: number): void;
}

export function createJtiStore(maxEntries = JTI_STORE_MAX_ENTRIES): JtiStore {
  const used = new Map<string, number>();
  const sweep = (now: number) => {
    for (const [jti, keepUntil] of used) {
      if (keepUntil <= now) used.delete(jti);
    }
  };
  return {
    claim(jti, keepUntilMs, now) {
      const known = used.get(jti);
      if (known !== undefined && known > now) return false;
      if (known === undefined && used.size >= maxEntries) {
        sweep(now);
        if (used.size >= maxEntries) return "full";
      }
      used.set(jti, keepUntilMs);
      return true;
    },
    size: () => used.size,
    sweep,
  };
}

export interface TicketVerifier {
  verify(ticket: string, now: number): Promise<TicketResult>;
  /** Startet das periodische Aufräumen des jti-Speichers. */
  start(clock: () => number): void;
  stop(): void;
}

export function createTicketVerifier(secret: string, store: JtiStore = createJtiStore()): TicketVerifier {
  const keyBytes = new TextEncoder().encode(secret);
  let key: Promise<webcrypto.CryptoKey> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Einmal importierter Schlüssel statt Import je Handshake.
  const getKey = () => {
    key ??= crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return key;
  };

  return {
    async verify(ticket, now) {
      if (ticket.length === 0 || ticket.length > TICKET_MAX_LENGTH) return { ok: false, reason: "invalid" };
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(ticket, await getKey(), {
          algorithms: [REALTIME_TICKET.algorithm],
          audience: REALTIME_TICKET.audience,
          issuer: REALTIME_TICKET.issuer,
          currentDate: new Date(now),
          clockTolerance: TICKET_CLOCK_TOLERANCE_SEC,
          requiredClaims: ["sub", "exp", "jti"],
        }));
      } catch (error) {
        if (error instanceof errors.JWTExpired) return { ok: false, reason: "expired" };
        if (error instanceof errors.JOSEError) return { ok: false, reason: "invalid" };
        throw error;
      }
      const parsed = realtimeTicketClaimsSchema.safeParse(payload);
      if (!parsed.success) return { ok: false, reason: "invalid" };
      const claims = parsed.data;
      const toleranceMs = TICKET_CLOCK_TOLERANCE_SEC * 1_000;
      // Tickets leben höchstens ttlSec – ein weiter in der Zukunft liegendes exp ist ungültig ausgestellt.
      if (claims.exp * 1_000 - now > REALTIME_TICKET.ttlSec * 1_000 + toleranceMs)
        return { ok: false, reason: "invalid" };
      if (claims.iat !== undefined && claims.iat * 1_000 > now + toleranceMs) return { ok: false, reason: "invalid" };
      const claimed = store.claim(claims.jti, claims.exp * 1_000 + toleranceMs, now);
      if (claimed === "full") return { ok: false, reason: "store_full" };
      if (!claimed) return { ok: false, reason: "replayed" };
      return { ok: true, claims };
    },

    start(clock) {
      if (timer !== undefined) return;
      timer = setInterval(() => store.sweep(clock()), JTI_SWEEP_INTERVAL_MS);
      timer.unref();
    },

    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
