import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger";
import { createTurnstileVerifier, hostnamesOf, TURNSTILE_TOKEN_TTL_MS } from "./turnstile";

const logger = createLogger({ level: "silent" });

function verifier(responses: Array<() => Response | Promise<Response>>, clock = { now: 1_000 }) {
  const fetchMock = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (next === undefined) throw new Error("keine Antwort mehr vorbereitet");
    return next();
  });
  const instance = createTurnstileVerifier({
    secretKey: "0x4AAAAAAA-echter-schluessel",
    allowedHostnames: hostnamesOf(["https://Quiz.Example.com", "http://localhost:3000"]),
    fetch: fetchMock,
    logger,
    now: () => clock.now,
  });
  return { instance, fetchMock, clock };
}

const ok = () => Response.json({ success: true, hostname: "quiz.example.com" });

describe("Turnstile-Siteverify", () => {
  it("akzeptiert success + eigenen Hostnamen und liefert den Prüfzeitpunkt", async () => {
    const { instance } = verifier([ok]);
    expect(await instance.verify("t1", "203.0.113.1")).toEqual({ ok: true, verifiedAt: 1_000 });
  });

  it("wiederholt bei internal-error einmal mit demselben idempotency_key", async () => {
    const { instance, fetchMock } = verifier([
      () => Response.json({ success: false, "error-codes": ["internal-error"] }),
      ok,
    ]);
    expect((await instance.verify("t2", null)).ok).toBe(true);
    const keys = fetchMock.mock.calls.map(([, init]) => new URLSearchParams(String(init?.body)));
    expect(keys).toHaveLength(2);
    expect(keys[0]?.get("idempotency_key")).toBe(keys[1]?.get("idempotency_key"));
    expect(keys[0]?.has("remoteip")).toBe(false);
  });

  it("timeout-or-duplicate → replayed; andere Fehler → rejected; HTTP 4xx → unavailable", async () => {
    const { instance } = verifier([
      () => Response.json({ success: false, "error-codes": ["timeout-or-duplicate"] }),
      () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
      () => new Response("nein", { status: 400 }),
    ]);
    expect(await instance.verify("a", null)).toMatchObject({ ok: false, reason: "replayed" });
    expect(await instance.verify("b", null)).toMatchObject({ ok: false, reason: "rejected" });
    expect(await instance.verify("c", null)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("merkt verbrauchte Tokens lokal bis zum Ablauf (300 s)", async () => {
    const { instance, fetchMock, clock } = verifier([ok, ok]);
    expect((await instance.verify("einmal", null)).ok).toBe(true);
    expect(await instance.verify("einmal", null)).toEqual({ ok: false, reason: "replayed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock.now += TURNSTILE_TOKEN_TTL_MS;
    expect((await instance.verify("einmal", null)).ok).toBe(true);
  });

  it("lehnt fremde oder fehlende Hostnamen ab", async () => {
    const { instance } = verifier([
      () => Response.json({ success: true, hostname: "evil.example.com" }),
      () => Response.json({ success: true }),
    ]);
    expect(await instance.verify("h1", null)).toEqual({ ok: false, reason: "hostname_mismatch" });
    expect(await instance.verify("h2", null)).toEqual({ ok: false, reason: "hostname_mismatch" });
  });
});
