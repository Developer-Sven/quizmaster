import { type ErrorCode, errorCodeSchema, ProtocolError } from "./errors.ts";
import * as z from "./zod.ts";

/** Fehlerteil eines Acks (docs/05 §Ack-Format). */
export interface AckErrorBody {
  code: ErrorCode;
  /** Nur für Logs/Debugging – der Client zeigt nie `message`, sondern übersetzt `code`. */
  message: string;
  /** Nur bei `RATE_LIMITED`: frühester sinnvoller neuer Versuch in ms. */
  retryAfterMs?: number;
}

export interface AckSuccess<T> {
  ok: true;
  data: T;
}

export interface AckFailure {
  ok: false;
  error: AckErrorBody;
}

export type AckResponse<T = null> = AckSuccess<T> | AckFailure;

/** Ack-Callback eines Client→Server-Events (Socket.IO). */
export type Ack<T = null> = (res: AckResponse<T>) => void;

/** Erfolgreiches Ack; ohne Argument mit `data: null`. */
export function ackOk(): AckSuccess<null>;
export function ackOk<T>(data: T): AckSuccess<T>;
export function ackOk<T>(data?: T): AckSuccess<T | null> {
  return { ok: true, data: data === undefined ? null : data };
}

/** Fehler-Ack. `retryAfterMs` wird auf ganze, nicht negative Millisekunden aufgerundet. */
export function ackError(code: ErrorCode, message?: string, retryAfterMs?: number): AckFailure {
  const error: AckErrorBody = { code, message: message ?? code };
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) {
    error.retryAfterMs = Math.max(0, Math.ceil(retryAfterMs));
  }
  return { ok: false, error };
}

/** Wandelt einen `ProtocolError` in ein Fehler-Ack um. */
export function ackFromError(error: ProtocolError): AckFailure {
  return ackError(error.code, error.message, error.retryAfterMs);
}

/** Type Guard für bekannte fachliche Fehler (alles andere → `INTERNAL`). */
export function isProtocolError(error: unknown): error is ProtocolError {
  return error instanceof ProtocolError;
}

export const ackErrorBodySchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().max(500),
  retryAfterMs: z.int().min(0).optional(),
});

/** zod-Schema der Ack-Antwort zu einem Daten-Schema (z. B. für Client-seitige Prüfung). */
export function ackResponseSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), data }),
    z.strictObject({ ok: z.literal(false), error: ackErrorBodySchema }),
  ]);
}
