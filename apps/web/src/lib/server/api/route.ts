/**
 * Gemeinsamer Rahmen aller Web-API-Routen: Request-ID, fachliche Fehler → einheitliche Fehlerantwort,
 * unerwartete Fehler → geloggt (mit Request-ID, ohne Secrets) und als INTERNAL bzw. SERVER_BUSY (Datenbank
 * weg) beantwortet – nie Stacktraces oder interne Meldungen an Clients (docs/02 §Fehlerbehandlung).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { Logger } from "pino";
import { getServerContext, type ServerContext } from "../context";
import { isDatabaseUnavailable } from "../db";
import { ApiError, asApiError, errorResponse } from "../http";
import { getLogger } from "../logger";
import type { WebEndpoint } from "../rate-limit";

export type ApiHandler = (request: NextRequest, ctx: ServerContext) => Promise<Response>;

export interface RunApiOptions {
  /** Antwort, falls der Kontext (Env/DB) gar nicht erst aufgebaut werden kann oder Unerwartetes passiert. */
  onUnexpected?: () => Response;
}

function describe(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: "Unbekannt", message: "" };
}

function unexpected(error: unknown, logger: Logger, endpoint: WebEndpoint, requestId: string): ApiError {
  const unavailable = isDatabaseUnavailable(error);
  logger.error({ endpoint, requestId, error: describe(error) }, "Unerwarteter Fehler in API-Route");
  return unavailable
    ? new ApiError("SERVER_BUSY", "Dienst vorübergehend nicht verfügbar")
    : new ApiError("INTERNAL", "Interner Fehler");
}

/** Führt einen Handler mit explizitem Kontext-Lieferanten aus (Tests übergeben eigene Kontexte). */
export async function runApi(
  endpoint: WebEndpoint,
  request: NextRequest,
  context: () => ServerContext,
  handler: ApiHandler,
  options: RunApiOptions = {},
): Promise<Response> {
  const requestId = randomUUID();
  let logger: Logger | undefined;
  let response: Response;
  try {
    const ctx = context();
    logger = ctx.logger;
    response = await handler(request, ctx);
  } catch (error) {
    const known = asApiError(error);
    if (known !== null) {
      response = errorResponse(known);
    } else if (options.onUnexpected !== undefined) {
      (logger ?? getLogger()).error({ endpoint, requestId, error: describe(error) }, "API-Route fehlgeschlagen");
      response = options.onUnexpected();
    } else {
      response = errorResponse(unexpected(error, logger ?? getLogger(), endpoint, requestId));
    }
  }
  response.headers.set("X-Request-Id", requestId);
  return response;
}

/** Route-Handler für `route.ts`: nutzt den Prozess-Kontext (`getServerContext`). */
export function apiRoute(
  endpoint: WebEndpoint,
  handler: ApiHandler,
  options: RunApiOptions = {},
): (request: NextRequest) => Promise<Response> {
  return (request) => runApi(endpoint, request, getServerContext, handler, options);
}
