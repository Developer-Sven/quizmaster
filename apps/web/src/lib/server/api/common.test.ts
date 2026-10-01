/**
 * `verifyTurnstileToken` (common.ts): Ergebnis der Siteverify-Prüfung → API-Fehler und Log-Stufe. Normale
 * Ablehnungen (falsches oder verbrauchtes Token) sind bei Bot-Verkehr erwartbar und bleiben `info`; ein fremder
 * Hostname deutet auf eine Fehlkonfiguration (APP_ORIGIN passt nicht zu den Widget-Hostnamen) und wird `warn`;
 * nicht verfügbar oder nicht konfiguriert → 503 (fail-closed).
 */
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ServerContext } from "../context";
import { ApiError } from "../http";
import { createLogger } from "../logger";
import type { TurnstileOutcome } from "../turnstile";
import { verifyTurnstileToken } from "./common";

function contextWith(outcome: TurnstileOutcome | null) {
  const lines: string[] = [];
  const logger = createLogger({
    level: "info",
    destination: new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    }),
  });
  const turnstile = outcome === null ? null : { verify: async () => outcome };
  // Nur die Teile, die verifyTurnstileToken nutzt.
  const ctx = { logger, turnstile } as unknown as ServerContext;
  const levels = () => lines.map((line) => (JSON.parse(line) as { level: number }).level);
  return { ctx, lines, levels };
}

async function failure(ctx: ServerContext): Promise<ApiError> {
  try {
    await verifyTurnstileToken(ctx, "token", null);
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("verifyTurnstileToken hat nicht abgelehnt");
}

describe("verifyTurnstileToken – Fehlercode und Log-Stufe", () => {
  it("gültig → Prüfzeitpunkt, ohne Log", async () => {
    const { ctx, lines } = contextWith({ ok: true, verifiedAt: 1_234 });
    expect(await verifyTurnstileToken(ctx, "token", null)).toBe(1_234);
    expect(lines).toEqual([]);
  });

  it("falsches oder verbrauchtes Token → 403 TURNSTILE_REQUIRED, Log `info`", async () => {
    for (const outcome of [
      { ok: false, reason: "rejected", errorCodes: ["invalid-input-response"] },
      { ok: false, reason: "replayed" },
    ] as const) {
      const { ctx, levels } = contextWith(outcome);
      const error = await failure(ctx);
      expect([error.code, error.status]).toEqual(["TURNSTILE_REQUIRED", 403]);
      expect(levels()).toEqual([30]);
    }
  });

  it("fremder Hostname → 403 TURNSTILE_REQUIRED, Log `warn` (Hinweis auf Fehlkonfiguration)", async () => {
    const { ctx, levels, lines } = contextWith({ ok: false, reason: "hostname_mismatch" });
    const error = await failure(ctx);
    expect(error.code).toBe("TURNSTILE_REQUIRED");
    expect(levels()).toEqual([40]);
    expect(lines.join("")).toContain("APP_ORIGIN");
  });

  it("nicht verfügbar → 503 SERVER_BUSY; kein Secret konfiguriert → 503 mit Log `error`", async () => {
    const unavailable = contextWith({ ok: false, reason: "unavailable" });
    expect((await failure(unavailable.ctx)).code).toBe("SERVER_BUSY");

    const missing = contextWith(null);
    const error = await failure(missing.ctx);
    expect([error.code, error.status]).toEqual(["SERVER_BUSY", 503]);
    expect(missing.levels()).toEqual([50]);
  });
});
