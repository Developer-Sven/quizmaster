import { z } from "zod";

/**
 * Alle Fehlercodes des Protokolls (docs/05 §Fehlercodes). Der Client zeigt je Code genau eine Darstellung
 * (docs/09 §11); `message` dient nur Logs/Debugging und wird nie angezeigt.
 */
export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "UNAUTHORIZED",
  "UPDATE_REQUIRED",
  "RATE_LIMITED",
  "TOO_MANY_CONNECTIONS",
  "SERVER_BUSY",
  "LOBBY_NOT_FOUND",
  "LOBBY_FULL",
  "GAME_IN_PROGRESS",
  "NOT_HOST",
  "NOT_YOUR_TURN",
  "INVALID_OPTION",
  "INVALID_PHASE",
  "ALREADY_ANSWERED",
  "TOO_EARLY",
  "TOO_LATE",
  "NAME_REJECTED",
  "NOT_ENOUGH_PLAYERS",
  "KICKED",
  "BANNED",
  "RESIGNED",
  "LOBBY_CREATION_DISABLED",
  "TURNSTILE_REQUIRED",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

const errorCodeSet: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && errorCodeSet.has(value);
}

/**
 * HTTP-Status je Fehlercode für die Web-API (Route Handler). Für Socket-Acks irrelevant; die Zuordnung
 * sorgt nur dafür, dass Web-Routen denselben Code mit einem passenden Status liefern.
 */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  UPDATE_REQUIRED: 426,
  RATE_LIMITED: 429,
  TOO_MANY_CONNECTIONS: 429,
  SERVER_BUSY: 503,
  LOBBY_NOT_FOUND: 404,
  LOBBY_FULL: 409,
  GAME_IN_PROGRESS: 409,
  NOT_HOST: 403,
  NOT_YOUR_TURN: 409,
  INVALID_OPTION: 422,
  INVALID_PHASE: 409,
  ALREADY_ANSWERED: 409,
  TOO_EARLY: 425,
  TOO_LATE: 409,
  NAME_REJECTED: 422,
  NOT_ENOUGH_PLAYERS: 409,
  KICKED: 403,
  BANNED: 403,
  RESIGNED: 409,
  LOBBY_CREATION_DISABLED: 503,
  TURNSTILE_REQUIRED: 403,
  INTERNAL: 500,
};

/**
 * Erwarteter, fachlicher Fehler mit Protokoll-Code. Handler werfen ihn; der Event-/Route-Wrapper
 * übersetzt ihn in ein Ack bzw. eine HTTP-Antwort (unerwartete Fehler werden zu `INTERNAL`).
 */
export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(code: ErrorCode, message?: string, retryAfterMs?: number) {
    super(message ?? code);
    this.name = "ProtocolError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
