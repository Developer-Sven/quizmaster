import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ensureSession, errorCodeFromResponse, fetchTicket, resetSessionForTests } from "./session";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("errorCodeFromResponse", () => {
  it("liest { error: { code } } und retryAfterMs", () => {
    expect(errorCodeFromResponse(429, { error: { code: "RATE_LIMITED", message: "x", retryAfterMs: 1500 } })).toEqual({
      code: "RATE_LIMITED",
      retryAfterMs: 1500,
    });
    expect(errorCodeFromResponse(403, { error: { code: "TURNSTILE_REQUIRED", message: "x" } }).code).toBe(
      "TURNSTILE_REQUIRED",
    );
  });

  it("fällt ohne verwertbaren Body auf den HTTP-Status zurück", () => {
    expect(errorCodeFromResponse(401, null).code).toBe("UNAUTHORIZED");
    expect(errorCodeFromResponse(429, "Too Many").code).toBe("RATE_LIMITED");
    expect(errorCodeFromResponse(503, {}).code).toBe("SERVER_BUSY");
    expect(errorCodeFromResponse(500, { error: { code: "FANTASY" } }).code).toBe("INTERNAL");
  });
});

describe("Session und Ticket", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetSessionForTests();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("legt die Session einmal pro Seite an (POST /api/session mit {})", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { created: true }));
    await ensureSession();
    await ensureSession();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/session");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
    await ensureSession({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("versucht es nach einem Fehler erneut und meldet den Code", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: { code: "SERVER_BUSY", message: "x" } }));
    await expect(ensureSession()).rejects.toMatchObject({ code: "SERVER_BUSY", status: 503 });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { created: false }));
    await expect(ensureSession()).resolves.toBeUndefined();
  });

  it("holt ein Ticket und prüft die Antwort", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ticket: "eyJ.ticket" }));
    await expect(fetchTicket()).resolves.toBe("eyJ.ticket");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ticket: "" }));
    await expect(fetchTicket()).rejects.toMatchObject({ code: "INTERNAL" });
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "x" } }));
    await expect(fetchTicket()).rejects.toBeInstanceOf(ApiError);
  });

  it("sendet ein Turnstile-Token nur, wenn eines vorliegt", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ticket: "t" }));
    await fetchTicket("token-123");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ turnstileToken: "token-123" }));
  });

  it("meldet Netzfehler als NETWORK", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(fetchTicket()).rejects.toMatchObject({ code: "NETWORK", status: 0 });
  });
});
