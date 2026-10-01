/** Ticket-Prüfung (jose HS256, Claims, Frist) und jti-Speicher (einmalig, TTL, Obergrenze). */
import { randomUUID } from "node:crypto";
import { hmacKeyFromSecret, REALTIME_TICKET } from "@quizmaster/shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createJtiStore, createTicketVerifier, TICKET_CLOCK_TOLERANCE_SEC } from "../../src/auth/ticket.ts";
import { mintTicket } from "../helpers/index.ts";

const SECRET = "t".repeat(43);

describe("Ticket-Prüfung", () => {
  it("akzeptiert ein gültiges Ticket genau einmal und liefert die Claims", async () => {
    const verifier = createTicketVerifier(SECRET);
    const guestId = randomUUID();
    const now = Date.now();
    const ticket = await mintTicket(guestId, { secret: SECRET, nowMs: now, tsv: now - 1_000 });
    const first = await verifier.verify(ticket, now);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.claims.sub).toBe(guestId);
      expect(first.claims.tsv).toBe(now - 1_000);
    }
    expect(await verifier.verify(ticket, now + 1_000)).toEqual({ ok: false, reason: "replayed" });
  });

  it("lehnt abgelaufene und ungültige Tickets ab", async () => {
    const verifier = createTicketVerifier(SECRET);
    const now = Date.now();
    const expired = await mintTicket(randomUUID(), { secret: SECRET, nowMs: now - 120_000 });
    expect(await verifier.verify(expired, now)).toEqual({ ok: false, reason: "expired" });
    const tolerated = await mintTicket(randomUUID(), { secret: SECRET, nowMs: now - 62_000 });
    expect((await verifier.verify(tolerated, now)).ok).toBe(true);
    for (const ticket of [
      await mintTicket(randomUUID(), { secret: "x".repeat(43), nowMs: now }),
      await mintTicket(randomUUID(), { secret: SECRET, nowMs: now, audience: "web" }),
      await mintTicket(randomUUID(), { secret: SECRET, nowMs: now, issuer: "realtime" }),
      await mintTicket(randomUUID(), { secret: SECRET, nowMs: now, jti: "kurz" }),
      await mintTicket("keine-uuid", { secret: SECRET, nowMs: now }),
      await mintTicket(randomUUID(), { secret: SECRET, nowMs: now, expiresInSec: 600 }),
      await mintTicket(randomUUID(), { secret: SECRET, nowMs: now, omit: ["sub"] }),
      await mintTicket(randomUUID(), { algorithm: "none", nowMs: now }),
      await mintTicket(randomUUID(), { secret: SECRET, nowMs: now, extraClaims: { tsv: "gestern" } }),
      "",
      "a.b.c",
    ]) {
      expect(await verifier.verify(ticket, now)).toMatchObject({ ok: false, reason: "invalid" });
    }
  });

  it("Schlüssel-Vertrag mit apps/web: UTF-8-Bytes des Secrets, kein Base64-Decode", async () => {
    // Ein typisches base64url-Secret: als Bytes interpretiert wäre es ein anderer Schlüssel.
    const secret = "q3Jx9_Lw-ZbVtR8sKpN2mYcE4hGfA7uD1oXiWnQeTzS";
    const verifier = createTicketVerifier(secret);
    const now = Date.now();
    const sign = (key: Uint8Array) => {
      const iat = Math.floor(now / 1_000);
      return new SignJWT({})
        .setProtectedHeader({ alg: REALTIME_TICKET.algorithm, typ: "JWT" })
        .setSubject(randomUUID())
        .setAudience(REALTIME_TICKET.audience)
        .setIssuer(REALTIME_TICKET.issuer)
        .setIssuedAt(iat)
        .setExpirationTime(iat + REALTIME_TICKET.ttlSec)
        .setJti(randomUUID().replaceAll("-", ""))
        .sign(key);
    };
    expect((await verifier.verify(await sign(hmacKeyFromSecret(secret)), now)).ok).toBe(true);
    expect(await verifier.verify(await sign(Buffer.from(secret, "base64url")), now)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("jti-Speicher: merkt IDs bis zum Ablauf (+ Toleranz), räumt auf und ist begrenzt", () => {
    const store = createJtiStore(2);
    const now = 1_000_000;
    expect(store.claim("a", now + 60_000, now)).toBe(true);
    expect(store.claim("a", now + 60_000, now + 10)).toBe(false);
    expect(store.claim("b", now + 1_000, now)).toBe(true);
    expect(store.claim("c", now + 60_000, now)).toBe("full");
    // Nach Ablauf von „b“ ist wieder Platz.
    expect(store.claim("c", now + 60_000, now + 2_000)).toBe(true);
    expect(store.size()).toBe(2);
    store.sweep(now + 60_001);
    expect(store.size()).toBe(0);
    expect(TICKET_CLOCK_TOLERANCE_SEC).toBeGreaterThan(0);
  });

  it("ein voller jti-Speicher lehnt neue Tickets ab (fail-closed)", async () => {
    const verifier = createTicketVerifier(SECRET, createJtiStore(1));
    const now = Date.now();
    expect((await verifier.verify(await mintTicket(randomUUID(), { secret: SECRET, nowMs: now }), now)).ok).toBe(true);
    expect(await verifier.verify(await mintTicket(randomUUID(), { secret: SECRET, nowMs: now }), now)).toEqual({
      ok: false,
      reason: "store_full",
    });
  });
});
