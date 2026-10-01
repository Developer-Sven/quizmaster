/**
 * HTTP-Helfer der Web-API (docs/02 §Fehlerbehandlung): einheitliche Fehlerantworten
 * `{ error: { code, message, retryAfterMs? } }` mit Status aus `ERROR_HTTP_STATUS`, nie Stacktraces oder
 * interne Meldungen; Body-Lesen mit Größengrenze und zod-Validierung (strictObject, docs/06 Invariante 5).
 */
import { ackError, ERROR_HTTP_STATUS, type ErrorCode, type HttpErrorBody, isErrorCode } from "@quizmaster/shared";
import { NextResponse } from "next/server";
import type { z } from "zod";

/** Höchstgröße eines Request-Bodys der Web-API (Turnstile-Token ≤ 2.048 Zeichen + JSON). */
export const MAX_JSON_BODY_BYTES = 4_096;

export const NO_STORE = "no-store";

/**
 * Fachlicher Fehler einer API-Route. Status standardmäßig aus `ERROR_HTTP_STATUS`; `status` überschreibt
 * ihn nur in dokumentierten Ausnahmen (fremde Origin → 403). `message` ist ein fester, ungefährlicher Text.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(code: ErrorCode, message: string, options: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = options.status ?? ERROR_HTTP_STATUS[code];
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Erkennt fachliche Fehler auch über Bundle-Grenzen (Next bündelt Routen getrennt → `instanceof` wäre
 * unzuverlässig): `ApiError` und `ProtocolError` aus `@quizmaster/shared`.
 */
export function asApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (!(error instanceof Error) || (error.name !== "ApiError" && error.name !== "ProtocolError")) return null;
  const { code, status, retryAfterMs } = error as Error & { code?: unknown; status?: unknown; retryAfterMs?: unknown };
  if (!isErrorCode(code)) return null;
  return new ApiError(code, error.message, {
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
  });
}

/** Sekunden für `Retry-After` (mindestens 1). */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1_000));
}

/** Fehlerantwort im Ack-Format; bei RATE_LIMITED mit `Retry-After`. Immer `Cache-Control: no-store`. */
export function errorResponse(error: ApiError): NextResponse<HttpErrorBody> {
  const body: HttpErrorBody = { error: ackError(error.code, error.message, error.retryAfterMs).error };
  const headers = new Headers({ "Cache-Control": NO_STORE });
  if (error.retryAfterMs !== undefined && (error.code === "RATE_LIMITED" || error.status === 429)) {
    headers.set("Retry-After", String(retryAfterSeconds(error.retryAfterMs)));
  }
  return NextResponse.json(body, { status: error.status, headers });
}

/** JSON-Antwort ohne Caching (Standard aller Web-API-Routen außer `/api/categories`). */
export function noStoreJson<T>(body: T, init: { status?: number } = {}): NextResponse<T> {
  return NextResponse.json(body, { status: init.status ?? 200, headers: { "Cache-Control": NO_STORE } });
}

const invalidBody = () => new ApiError("VALIDATION_FAILED", "Ungültiger Request-Body");

/** Liest den Body höchstens bis `maxBytes` (Stream wird danach abgebrochen). */
async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw invalidBody();
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw invalidBody();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidBody();
  }
}

/**
 * JSON-Body lesen und mit zod prüfen. Leerer Body gilt als `{}` (docs/05: Body `{}` oder `{ turnstileToken }`).
 * Kein JSON, zu groß oder unbekannte Felder → `VALIDATION_FAILED` (400).
 */
export async function readJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<z.output<T>> {
  const text = await readLimitedText(request, maxBytes);
  let raw: unknown = {};
  if (text.trim() !== "") {
    try {
      raw = JSON.parse(text);
    } catch {
      throw invalidBody();
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalidBody();
  return parsed.data;
}
