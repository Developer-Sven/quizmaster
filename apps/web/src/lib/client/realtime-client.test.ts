import { describe, expect, it } from "vitest";
import { parseAck, retryDelayMs } from "./realtime-client";

describe("parseAck", () => {
  it("prüft Ack-Daten gegen das Schema des Events", () => {
    expect(parseAck("lobby:create", { ok: true, data: { code: "ABC234" } })).toEqual({
      ok: true,
      data: { code: "ABC234" },
    });
    expect(parseAck("game:answer", { ok: true, data: { accepted: true } })).toEqual({
      ok: true,
      data: { accepted: true },
    });
    expect(parseAck("lobby:start", { ok: true, data: null })).toEqual({ ok: true, data: null });
  });

  it("liefert Fehlercodes (mit retryAfterMs) statt der Server-Message", () => {
    expect(parseAck("lobby:join", { ok: false, error: { code: "LOBBY_FULL", message: "voll" } })).toEqual({
      ok: false,
      code: "LOBBY_FULL",
    });
    expect(
      parseAck("lobby:join", { ok: false, error: { code: "RATE_LIMITED", message: "x", retryAfterMs: 1200 } }),
    ).toEqual({ ok: false, code: "RATE_LIMITED", retryAfterMs: 1200 });
  });

  it("wertet unerwartete Antworten als INTERNAL (z. B. Ack mit richtig/falsch)", () => {
    expect(parseAck("game:answer", { ok: true, data: { accepted: true, correct: true } })).toEqual({
      ok: false,
      code: "INTERNAL",
    });
    expect(parseAck("lobby:create", { ok: true, data: { code: "abc" } })).toEqual({ ok: false, code: "INTERNAL" });
    expect(parseAck("lobby:create", undefined)).toEqual({ ok: false, code: "INTERNAL" });
    expect(parseAck("lobby:create", { ok: false, error: { code: "FANTASY", message: "x" } })).toEqual({
      ok: false,
      code: "INTERNAL",
    });
  });
});

describe("retryDelayMs", () => {
  it("wächst exponentiell mit Streuung und bleibt ≤ 5 s (docs/05)", () => {
    expect(retryDelayMs(0, () => 1)).toBe(1_000);
    expect(retryDelayMs(0, () => 0)).toBe(500);
    expect(retryDelayMs(1, () => 1)).toBe(2_000);
    expect(retryDelayMs(2, () => 1)).toBe(4_000);
    expect(retryDelayMs(3, () => 1)).toBe(5_000);
    expect(retryDelayMs(10, () => 1)).toBe(5_000);
    for (let attempt = 0; attempt < 12; attempt++) {
      const delay = retryDelayMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(5_000);
    }
  });
});
