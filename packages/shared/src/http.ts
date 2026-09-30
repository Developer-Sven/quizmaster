/**
 * HTTP-Endpunkte und ihre Request-/Response-Verträge (docs/02, docs/05 §Verbindung, docs/06).
 * Jeder Request-Body wird mit `strictObject` validiert (docs/06 Invariante 5).
 */
import { z } from "zod";
import { ackErrorBodySchema } from "./ack.ts";
import { TICKET_MAX_LENGTH } from "./auth.ts";

/** Alle HTTP-Endpunkte von Web und Realtime – jeder hat ein Rate-Limit (`limits.ts`). */
export const HTTP_ENDPOINTS = [
  "POST /api/session",
  "POST /api/realtime/ticket",
  "GET /api/categories",
  "GET /api/health",
  "GET /healthz",
  "GET /metrics",
] as const;
export type HttpEndpoint = (typeof HTTP_ENDPOINTS)[number];

/** Turnstile-Tokens sind laut Cloudflare höchstens 2.048 Zeichen lang. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;

const turnstileTokenSchema = z.string().min(1).max(TURNSTILE_TOKEN_MAX_LENGTH);

/** `POST /api/session` – Body `{}` oder (erste Session mit aktivem Turnstile) `{ turnstileToken }`. */
export const sessionRequestSchema = z.strictObject({ turnstileToken: turnstileTokenSchema.optional() });
export type SessionRequest = z.output<typeof sessionRequestSchema>;

/** `POST /api/realtime/ticket` – Body `{}` oder `{ turnstileToken }` (Notfall-Schalter turnstileOnJoin). */
export const ticketRequestSchema = z.strictObject({ turnstileToken: turnstileTokenSchema.optional() });
export type TicketRequest = z.output<typeof ticketRequestSchema>;

/** Antwort von `POST /api/realtime/ticket`. */
export const ticketResponseSchema = z.strictObject({ ticket: z.string().min(1).max(TICKET_MAX_LENGTH) });
export type TicketResponse = z.output<typeof ticketResponseSchema>;

/** Antwort von `GET /api/health` (Web) und `GET /healthz` (Realtime): ohne Details, nur `ok`. */
export const healthResponseSchema = z.strictObject({ ok: z.boolean() });
export type HealthResponse = z.output<typeof healthResponseSchema>;

/** Fehler-Body aller Web-API-Routen: gleicher Aufbau wie der Fehlerteil eines Acks. */
export const httpErrorBodySchema = z.strictObject({ error: ackErrorBodySchema });
export type HttpErrorBody = z.output<typeof httpErrorBodySchema>;
