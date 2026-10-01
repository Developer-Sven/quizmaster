/** Logger-Redaction (docs/06 §Logging): keine Tickets, Cookies, Authorization, URIs, Secrets oder IPs. */
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, createSecurityLog, guestTag } from "../../src/logger.ts";

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
      callback();
    },
  });
  return { logger: createLogger({ level: "debug", destination }), lines };
}

describe("Logger", () => {
  it("schwärzt Geheimnisse und IPs, kürzt die guestId zu einem Hash", () => {
    const { logger, lines } = capture();
    const guestId = randomUUID();
    logger.info(
      {
        guestId,
        ticket: "eyJhbGciOiJIUzI1NiJ9.geheim",
        MONGODB_URI: "mongodb://user:passwort@db.example:27017",
        ip: "203.0.113.7",
        nested: {
          guestId,
          cookie: "kd_sid=abc",
          authorization: "Bearer metrics-token",
          remoteAddress: "198.51.100.1",
          headers: { "cf-connecting-ip": "198.51.100.2", "x-forwarded-for": "198.51.100.3" },
        },
        deep: { deeper: { secret: "s3cr3t", guestId } },
        headers: { "x-forwarded-for": "198.51.100.4", cookie: "kd_sid=def" },
        phaseToken: 7,
      },
      "Probe",
    );
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    for (const leaked of [
      guestId,
      "geheim",
      "passwort",
      "203.0.113.7",
      "kd_sid",
      "metrics-token",
      "198.51.100",
      "s3cr3t",
    ]) {
      expect(line).not.toContain(leaked);
    }
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.guestId).toBe(guestTag(guestId));
    expect((record.nested as Record<string, unknown>).guestId).toBe(guestTag(guestId));
    expect(record.phaseToken).toBe(7);
    expect(record.msg).toBe("Probe");
    expect(record.app).toBe("quizmaster-realtime");
  });

  it("guestTag ist stabil, kurz und verrät die guestId nicht", () => {
    const guestId = randomUUID();
    expect(guestTag(guestId)).toBe(guestTag(guestId));
    expect(guestTag(guestId)).toMatch(/^g_[0-9a-f]{12}$/);
    expect(guestTag(guestId)).not.toContain(guestId.slice(0, 8));
    expect(guestTag(randomUUID())).not.toBe(guestTag(guestId));
  });

  it("Sicherheitsereignisse werden gezählt und gesammelt geloggt", () => {
    const { logger, lines } = capture();
    const security = createSecurityLog(logger, 60_000);
    security.flush();
    expect(lines).toHaveLength(0);
    security.record("handshake_rejected", "origin");
    security.record("handshake_rejected", "origin");
    security.record("limit_hit", "event.time-sync.socket");
    security.flush();
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as { security: unknown; msg: string };
    expect(record.msg).toBe("Sicherheitsereignisse");
    expect(record.security).toEqual({
      handshake_rejected: { origin: 2 },
      limit_hit: { "event.time-sync.socket": 1 },
    });
    security.flush();
    expect(lines).toHaveLength(1);
  });
});
