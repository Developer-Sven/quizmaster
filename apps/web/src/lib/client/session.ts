/**
 * Gast-Session und Realtime-Tickets (docs/05 §Verbindung 1, ADR-006): `POST /api/session` legt das
 * HttpOnly-Cookie an bzw. erneuert es (einmal pro Seitenaufruf), `POST /api/realtime/ticket` liefert ein
 * 60-s-Ticket für jeden Verbindungsversuch. Fehler kommen als `{ error: { code } }` (docs/06) und werden
 * zu `ApiError` mit Protokoll-Code; `NETWORK` = keine Antwort.
 */
import { type ErrorCode, isErrorCode, ticketResponseSchema } from "@quizmaster/shared";
import { z } from "zod";
import type { ClientErrorCode } from "./errors";

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(code: ClientErrorCode, status: number, retryAfterMs?: number) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Fehler-Body der Web-API, bewusst tolerant gelesen (nur `code` und optional `retryAfterMs`). */
const errorBodySchema = z.object({
  error: z.object({ code: z.string().max(64), retryAfterMs: z.number().int().min(0).optional() }),
});

/** Code aus einem Fehler-Body; ohne verwertbaren Body nach HTTP-Status. */
export function errorCodeFromResponse(status: number, body: unknown): { code: ErrorCode; retryAfterMs?: number } {
  const parsed = errorBodySchema.safeParse(body);
  if (parsed.success && isErrorCode(parsed.data.error.code)) {
    return { code: parsed.data.error.code, retryAfterMs: parsed.data.error.retryAfterMs };
  }
  if (status === 401) return { code: "UNAUTHORIZED" };
  if (status === 429) return { code: "RATE_LIMITED" };
  if (status === 503) return { code: "SERVER_BUSY" };
  return { code: "INTERNAL" };
}

async function readJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    // Kein gültiges JSON: wie ein leerer Body behandeln – der Status entscheidet dann über den Code.
    return null;
  }
}

/** Sendet `body` als JSON an einen Endpunkt der eigenen Origin; wirft `ApiError`. */
async function postJson(path: string, body: Record<string, unknown>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  const data = await readJson(response);
  if (!response.ok) {
    const { code, retryAfterMs } = errorCodeFromResponse(response.status, data);
    throw new ApiError(code, response.status, retryAfterMs);
  }
  return data;
}

function turnstileBody(token: string | null | undefined): Record<string, unknown> {
  return token ? { turnstileToken: token } : {};
}

let session: Promise<void> | null = null;

/**
 * Stellt die Gast-Session sicher: einmal pro Seitenaufruf `POST /api/session` (danach geteilt).
 * `force` erneuert sie (z. B. nach `UNAUTHORIZED`). Nach einem Fehler darf der nächste Aufruf neu versuchen.
 */
export function ensureSession(options: { force?: boolean; turnstileToken?: string | null } = {}): Promise<void> {
  if (session && !options.force && !options.turnstileToken) return session;
  const request = postJson("/api/session", turnstileBody(options.turnstileToken)).then(() => undefined);
  session = request;
  request.catch(() => {
    // Fehler behandelt der Aufrufer (er bekommt dasselbe Promise); hier nur den Merker freigeben.
    if (session === request) session = null;
  });
  return request;
}

/** Holt ein frisches Realtime-Ticket (JWT, 60 s, einmalig). */
export async function fetchTicket(turnstileToken?: string | null): Promise<string> {
  const data = await postJson("/api/realtime/ticket", turnstileBody(turnstileToken));
  const parsed = ticketResponseSchema.safeParse(data);
  if (!parsed.success) throw new ApiError("INTERNAL", 200);
  return parsed.data.ticket;
}

/** Nur für Tests: Merker der Session zurücksetzen. */
export function resetSessionForTests(): void {
  session = null;
}
