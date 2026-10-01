/**
 * `POST /api/session` – Gast-Session anlegen oder weiterverwenden (docs/02 §Datenfluss: Beitreten,
 * docs/06 §Identität, §Bot-Schutz). Reihenfolge: Origin (403) → Rate-Limit IP 10/10 min (429) → Body (400)
 * → gültige Session? weiterverwenden (lastSeen, ggf. rollierend erneuern) : [Turnstile-Pflicht (403/503)]
 * → neuer Gast (`crypto.randomUUID()`) + Cookie `kd_sid`.
 */
import { randomUUID } from "node:crypto";
import { sessionRequestSchema } from "@quizmaster/shared";
import { NextResponse } from "next/server";
import type { SessionResponse } from "../api-schemas";
import { ApiError, NO_STORE, readJsonBody } from "../http";
import { assertAllowedOrigin, clientAddress } from "../request-guards";
import { needsRenewal } from "../tokens";
import { consumeRateLimit, nowSeconds, readSession, setSessionCookie, verifyTurnstileToken } from "./common";
import type { ApiHandler } from "./route";

const ENDPOINT = "POST /api/session";

function sessionResponse(created: boolean): NextResponse<SessionResponse> {
  return NextResponse.json({ created }, { status: created ? 201 : 200, headers: { "Cache-Control": NO_STORE } });
}

export const handleSessionRequest: ApiHandler = async (request, ctx) => {
  assertAllowedOrigin(request.headers, ctx.env);
  const client = clientAddress(request.headers, ctx.env);
  await consumeRateLimit(ctx, ENDPOINT, "ip", client.key);
  const body = await readJsonBody(request, sessionRequestSchema);

  const nowMs = ctx.now();
  const now = new Date(nowMs);
  const nowSec = nowSeconds(nowMs);

  const session = await readSession(request, ctx, nowSec);
  if (session !== null && (await ctx.data.repos.guests.touch(session.sub, now))) {
    const response = sessionResponse(false);
    if (needsRenewal(session, nowSec)) await setSessionCookie(response, session.sub, ctx, nowSec);
    return response;
  }

  if (ctx.env.turnstile.enabled) {
    if (body.turnstileToken === undefined) throw new ApiError("TURNSTILE_REQUIRED", "Turnstile-Token fehlt");
    await verifyTurnstileToken(ctx, body.turnstileToken, client.ip);
  }

  const guestId = randomUUID();
  await ctx.data.repos.guests.create(guestId, now);
  const response = sessionResponse(true);
  await setSessionCookie(response, guestId, ctx, nowSec);
  ctx.logger.info({ guestId }, "Gast-Session angelegt");
  return response;
};
