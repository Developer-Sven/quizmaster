import { describe, expect, it } from "vitest";
import {
  connectErrorDataSchema,
  handshakeAuthSchema,
  hmacKeyFromSecret,
  REALTIME_TICKET,
  realtimeTicketClaimsSchema,
  realtimeTicketVerifyOptions,
  SESSION_COOKIE,
} from "./auth.ts";
import {
  categoriesResponseSchema,
  publicCategorySchema,
  sessionRequestSchema,
  sessionResponseSchema,
  ticketRequestSchema,
} from "./http.ts";
import { PROTOCOL_VERSION } from "./index.ts";
import { CLOCK_SYNC, clockOffsetSample, medianOffset, socketClientOptions, socketServerOptions } from "./transport.ts";

describe("Transport (docs/05 §Verbindung)", () => {
  it("nutzt die Server-Optionen aus docs/05", () => {
    expect(socketServerOptions()).toEqual({
      path: "/socket.io",
      serveClient: false,
      maxHttpBufferSize: 8_192,
      pingInterval: 20_000,
      pingTimeout: 20_000,
      connectTimeout: 10_000,
    });
    expect(socketClientOptions()).toMatchObject({ transports: ["websocket", "polling"], tryAllTransports: true });
    expect(socketClientOptions()).not.toBe(socketClientOptions());
  });

  it("berechnet den Uhren-Offset als Median", () => {
    expect(CLOCK_SYNC).toEqual({ samples: 5, sampleIntervalMs: 300, resyncIntervalMs: 60_000 });
    expect(clockOffsetSample(1_000, 1_100, 5_050)).toBe(4_000);
    expect(medianOffset([30, 10, 20])).toBe(20);
    expect(medianOffset([40, 10, 20, 30])).toBe(25);
    expect(medianOffset([])).toBe(0);
  });
});

describe("Session und Tickets (docs/05, docs/06)", () => {
  it("hat die Konstanten aus docs/06", () => {
    expect(SESSION_COOKIE).toMatchObject({ name: "kd_sid", maxAgeSec: 180 * 86_400, renewBelowSec: 30 * 86_400 });
    expect(REALTIME_TICKET).toEqual({ audience: "realtime", issuer: "web", algorithm: "HS256", ttlSec: 60 });
    expect(PROTOCOL_VERSION).toBe(6);
  });

  it("validiert den Handshake und die Ticket-Claims", () => {
    expect(handshakeAuthSchema.safeParse({ ticket: "a.b.c", protocolVersion: 1 }).success).toBe(true);
    expect(handshakeAuthSchema.safeParse({ ticket: "a.b.c" }).success).toBe(false);
    expect(handshakeAuthSchema.safeParse({ ticket: "x".repeat(2_049), protocolVersion: 1 }).success).toBe(false);
    expect(handshakeAuthSchema.safeParse({ ticket: "a.b.c", protocolVersion: 1, guestId: "x" }).success).toBe(false);
    const claims = {
      sub: "0f8fad5b-d9cb-469f-a165-70867728950e",
      aud: "realtime",
      iss: "web",
      exp: 1_727_000_060,
      iat: 1_727_000_000,
      jti: "b1d9f0a6c8e44f3a9f1e2d3c4b5a6978",
    };
    expect(realtimeTicketClaimsSchema.safeParse(claims).success).toBe(true);
    expect(realtimeTicketClaimsSchema.safeParse({ ...claims, tsv: 1_727_000_000_000 }).success).toBe(true);
    expect(realtimeTicketClaimsSchema.safeParse({ ...claims, aud: "web" }).success).toBe(false);
    expect(realtimeTicketClaimsSchema.safeParse({ ...claims, sub: "admin" }).success).toBe(false);
  });

  it("validiert die HTTP-Bodies von Session und Ticket streng", () => {
    for (const schema of [sessionRequestSchema, ticketRequestSchema]) {
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ turnstileToken: "0.abc" }).success).toBe(true);
      expect(schema.safeParse({ turnstileToken: "" }).success).toBe(false);
      expect(schema.safeParse({ turnstileToken: "x".repeat(2_049) }).success).toBe(false);
      expect(schema.safeParse({ guestId: "x" }).success).toBe(false);
    }
  });
});

describe("Ticket-Schlüssel und Prüfoptionen (Vertrag Web ↔ Realtime)", () => {
  it("HMAC-Schlüssel = UTF-8-Bytes des Secret-Strings (kein Base64-Decode)", () => {
    expect([...hmacKeyFromSecret("aB3=")]).toEqual([0x61, 0x42, 0x33, 0x3d]);
    expect([...hmacKeyFromSecret("ä€")]).toEqual([0xc3, 0xa4, 0xe2, 0x82, 0xac]);
    expect(() => hmacKeyFromSecret("")).toThrow();
  });

  it("Prüfoptionen: nur HS256, aud realtime, iss web, Pflicht-Claims – je Aufruf frisch", () => {
    const options = realtimeTicketVerifyOptions();
    expect(options).toEqual({
      algorithms: ["HS256"],
      audience: "realtime",
      issuer: "web",
      requiredClaims: ["sub", "exp", "jti"],
    });
    options.algorithms.push("none");
    expect(realtimeTicketVerifyOptions().algorithms).toEqual(["HS256"]);
  });
});

describe("connect_error-Daten (docs/05 §Verbindung 3)", () => {
  it("akzeptiert nur { code, retryAfterMs? } mit bekanntem Code und ganzer Wartezeit ≥ 0", () => {
    expect(connectErrorDataSchema.safeParse({ code: "UNAUTHORIZED" }).success).toBe(true);
    expect(connectErrorDataSchema.safeParse({ code: "RATE_LIMITED", retryAfterMs: 1_500 }).success).toBe(true);
    expect(connectErrorDataSchema.safeParse({ code: "RATE_LIMITED", retryAfterMs: -1 }).success).toBe(false);
    expect(connectErrorDataSchema.safeParse({ code: "RATE_LIMITED", retryAfterMs: 1.5 }).success).toBe(false);
    expect(connectErrorDataSchema.safeParse({ code: "NOPE" }).success).toBe(false);
    expect(connectErrorDataSchema.safeParse({ code: "BANNED", message: "x" }).success).toBe(false);
  });
});

describe("Antwort-Verträge der Web-API", () => {
  it("POST /api/session → { created }", () => {
    expect(sessionResponseSchema.safeParse({ created: true }).success).toBe(true);
    expect(sessionResponseSchema.safeParse({ created: false }).success).toBe(true);
    expect(sessionResponseSchema.safeParse({}).success).toBe(false);
    expect(sessionResponseSchema.safeParse({ created: true, guestId: "x" }).success).toBe(false);
  });

  it("GET /api/categories → { categories: [{ id, name, icon, color, order }] } ohne private Felder", () => {
    const category = { id: "rund-um-die-welt", name: "Rund um die Welt", icon: "globe", color: "#1E6FD9", order: 1 };
    expect(publicCategorySchema.safeParse(category).success).toBe(true);
    expect(categoriesResponseSchema.safeParse({ categories: [category] }).success).toBe(true);
    expect(categoriesResponseSchema.safeParse({ categories: [] }).success).toBe(true);
    expect(publicCategorySchema.safeParse({ ...category, scope: "geheim" }).success).toBe(false);
    expect(publicCategorySchema.safeParse({ ...category, color: "blue" }).success).toBe(false);
    expect(publicCategorySchema.safeParse({ ...category, order: 0 }).success).toBe(false);
  });
});
