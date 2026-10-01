/**
 * `POST /api/session` – Gast-Session anlegen oder weiterverwenden (docs/02 §Datenfluss: Beitreten,
 * docs/06 §Identität, §Bot-Schutz). Reihenfolge: Origin (403) → Body (400) → gültige Session?
 * weiterverwenden (lastSeen, ggf. rollierend erneuern; begrenzt wie ein Ticket-Abruf, IP 300/min) :
 * Rate-Limit IP 10/10 min (429) → [Turnstile-Pflicht (403/503)] → neuer Gast (`crypto.randomUUID()`) +
 * Session-Cookie (`__Host-kd_sid` bzw. `kd_sid`, ADR-033).
 *
 * Das Limit 10/10 min zählt NUR neue Sessions (Orchestrator-Entscheidung zu docs/06 §Rate-Limits): Nutzer
 * hinter einer gemeinsamen IP (WLAN, CGNAT) dürfen sich durch Seitenaufrufe, Reloads oder Erneuerungen nicht
 * gegenseitig aussperren.
 */
import { randomUUID } from "node:crypto";
import { type SessionResponse, sessionRequestSchema } from "@quizmaster/shared";
import { NextResponse } from "next/server";
import { ApiError, NO_STORE, readJsonBody } from "../http";
import { assertAllowedOrigin, clientAddress } from "../request-guards";
import { needsRenewal } from "../tokens";
import { consumeRateLimit, nowSeconds, readSession, setSessionCookie, verifyTurnstileToken } from "./common";
import type { ApiHandler } from "./route";

const ENDPOINT = "POST /api/session";
/**
 * Weiterverwenden einer gültigen Session ist so billig wie ein Ticket-Abruf (Cookie prüfen, lastSeen setzen)
 * und zählt deshalb gegen dessen IP-Limit (300/min, Speicher) – begrenzt, ohne das Anlege-Limit zu berühren.
 * Es teilt sich den Eimer nur mit Tickets gültiger Sessions: Ticket-Anfragen ohne Session zählen getrennt
 * (`sessionlessIpKey` in ticket.ts) und können ihn nicht leeren.
 */
const REUSE_LIMIT_ENDPOINT = "POST /api/realtime/ticket";

function sessionResponse(created: boolean): NextResponse<SessionResponse> {
  return NextResponse.json({ created }, { status: created ? 201 : 200, headers: { "Cache-Control": NO_STORE } });
}

export const handleSessionRequest: ApiHandler = async (request, ctx) => {
  assertAllowedOrigin(request.headers, ctx.env);
  const client = clientAddress(request.headers, ctx.env);
  const body = await readJsonBody(request, sessionRequestSchema);

  const nowMs = ctx.now();
  const now = new Date(nowMs);
  const nowSec = nowSeconds(nowMs);

  const session = await readSession(request, ctx, nowSec);
  if (session !== null) {
    await consumeRateLimit(ctx, REUSE_LIMIT_ENDPOINT, "ip", client.key);
    if (await ctx.data.repos.guests.touch(session.sub, now)) {
      const response = sessionResponse(false);
      if (needsRenewal(session, nowSec)) await setSessionCookie(response, session.sub, ctx, nowSec);
      return response;
    }
  }

  // Ab hier entsteht ein neuer Gast – nur das zählt gegen IP 10/10 min (Mongo-Store, fail-closed).
  await consumeRateLimit(ctx, ENDPOINT, "ip", client.key);
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
