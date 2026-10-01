/**
 * Gast-Session und Realtime-Tickets (docs/05 §Verbindung 1, ADR-006): `POST /api/realtime/ticket` liefert ein
 * 60-s-Ticket für jeden Verbindungsversuch; `POST /api/session` legt das HttpOnly-Cookie nur an, wenn nötig
 * (erster Besuch ohne Merker oder Ticket → 401) – empfohlener Ablauf der Web-API: Ticket zuerst, bei 401
 * Session. Fehler kommen als `{ error: { code } }` (docs/06) und werden zu `ApiError` mit Protokoll-Code;
 * `NETWORK` = keine Antwort.
 */
import { type ErrorCode, isErrorCode, ticketResponseSchema } from "@quizmaster/shared";
import { z } from "zod";
import type { ClientErrorCode } from "./errors";
import { writeSessionHint } from "./storage";

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

let pending: Promise<void> | null = null;

/**
 * `POST /api/session`: legt die Gast-Session an bzw. bestätigt eine bestehende (das Server-Limit 10/10 min zählt
 * nur neue Gäste). Gleichzeitige Aufrufe teilen sich eine Anfrage (ein mitgegebenes Turnstile-Token sendet
 * immer neu); ist sie abgeschlossen, fragt der nächste Aufruf erneut. Erfolg setzt den Session-Merker.
 */
export function ensureSession(options: { turnstileToken?: string | null } = {}): Promise<void> {
  if (pending && !options.turnstileToken) return pending;
  const request = postJson("/api/session", turnstileBody(options.turnstileToken)).then(() => {
    writeSessionHint(true);
  });
  pending = request;
  const release = () => {
    if (pending === request) pending = null;
  };
  // Fehler behandelt der Aufrufer (er bekommt dasselbe Promise); hier nur den Merker freigeben.
  request.then(release, release);
  return request;
}

/** Holt ein frisches Realtime-Ticket (JWT, 60 s, einmalig); 401 = kein gültiges Session-Cookie (Merker weg). */
export async function fetchTicket(turnstileToken?: string | null): Promise<string> {
  let data: unknown;
  try {
    data = await postJson("/api/realtime/ticket", turnstileBody(turnstileToken));
  } catch (error) {
    if (error instanceof ApiError && error.code === "UNAUTHORIZED") writeSessionHint(false);
    throw error;
  }
  const parsed = ticketResponseSchema.safeParse(data);
  if (!parsed.success) throw new ApiError("INTERNAL", 200);
  writeSessionHint(true);
  return parsed.data.ticket;
}

/** Nur für Tests: laufende Session-Anfrage vergessen. */
export function resetSessionForTests(): void {
  pending = null;
}
