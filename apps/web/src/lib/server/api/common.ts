/**
 * Bausteine, die mehrere Handler teilen: Rate-Limit verbrauchen, Session aus dem Cookie lesen, Session-Cookie
 * (neu) setzen, Turnstile-Token prüfen. Alle Ablehnungen als `ApiError` mit festem Code.
 */
import type { RateLimitScope, SessionClaims } from "@quizmaster/shared";
import type { NextRequest, NextResponse } from "next/server";
import type { ServerContext } from "../context";
import { ApiError } from "../http";
import type { WebEndpoint } from "../rate-limit";
import { sessionCookie, sessionCookieName, signSessionToken, verifySessionToken } from "../tokens";

export const nowSeconds = (ms: number) => Math.floor(ms / 1_000);

/** Wirft 429 (mit Retry-After) bei Überschreitung, 503 wenn kein Limiter verfügbar ist (fail-closed). */
export async function consumeRateLimit(
  ctx: ServerContext,
  endpoint: WebEndpoint,
  scope: RateLimitScope,
  key: string,
): Promise<void> {
  const outcome = await ctx.limiters.consume(endpoint, scope, key);
  if (outcome.ok) return;
  if (outcome.reason === "limited") {
    throw new ApiError("RATE_LIMITED", "Zu viele Anfragen", { retryAfterMs: outcome.retryAfterMs });
  }
  throw new ApiError("SERVER_BUSY", "Rate-Limit nicht prüfbar");
}

/**
 * Gültige Session-Claims aus dem Session-Cookie (`__Host-kd_sid` bei https, sonst `kd_sid`, ADR-033) oder
 * `null` (fehlt, abgelaufen, manipuliert, falscher Name).
 */
export async function readSession(
  request: NextRequest,
  ctx: ServerContext,
  nowSec: number,
): Promise<SessionClaims | null> {
  const token = request.cookies.get(sessionCookieName(ctx.env.httpsOrigin))?.value;
  if (token === undefined) return null;
  return verifySessionToken(token, ctx.env.sessionSecret, nowSec);
}

/** Stellt ein neues Session-JWT (180 Tage) aus und setzt es als Cookie auf die Antwort. */
export async function setSessionCookie(
  response: NextResponse,
  guestId: string,
  ctx: ServerContext,
  nowSec: number,
): Promise<void> {
  const { token } = await signSessionToken(guestId, ctx.env.sessionSecret, nowSec);
  response.cookies.set(sessionCookie(token, ctx.env.httpsOrigin));
}

/**
 * Prüft ein Turnstile-Token serverseitig. Ungültig/Replay/fremder Hostname → 403 TURNSTILE_REQUIRED
 * (Client löst Turnstile erneut aus), Siteverify nicht erreichbar, lehnt die Konfiguration ab (turnstile.ts)
 * oder nicht konfiguriert → 503. Liefert den Prüfzeitpunkt (ms).
 *
 * Log-Stufen: falsche oder verbrauchte Tokens sind bei Bot-Verkehr erwartbar (`info`, sonst überdeckte eine
 * Bot-Welle echte Warnungen); ein fremder Hostname deutet auf eine Fehlkonfiguration (`APP_ORIGIN` passt nicht zu
 * den Hostnamen des Widgets) und wird `warn`.
 */
export async function verifyTurnstileToken(
  ctx: ServerContext,
  token: string,
  remoteIp: string | null,
): Promise<number> {
  if (ctx.turnstile === null) {
    ctx.logger.error("Turnstile-Token erhalten, aber TURNSTILE_SECRET_KEY ist nicht konfiguriert");
    throw new ApiError("SERVER_BUSY", "Turnstile nicht verfügbar");
  }
  const outcome = await ctx.turnstile.verify(token, remoteIp);
  if (outcome.ok) return outcome.verifiedAt;
  if (outcome.reason === "unavailable") throw new ApiError("SERVER_BUSY", "Turnstile nicht verfügbar");
  if (outcome.reason === "hostname_mismatch") {
    ctx.logger.warn(
      { reason: outcome.reason },
      "Turnstile-Token für fremden Hostnamen abgelehnt – APP_ORIGIN und Hostnamen des Widgets prüfen",
    );
  } else {
    ctx.logger.info({ reason: outcome.reason, errorCodes: outcome.errorCodes }, "Turnstile-Token abgelehnt");
  }
  throw new ApiError("TURNSTILE_REQUIRED", "Turnstile-Prüfung fehlgeschlagen");
}
