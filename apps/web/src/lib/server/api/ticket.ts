/**
 * `POST /api/realtime/ticket` – kurzlebiges Socket-Ticket (docs/05 §Verbindung 1, docs/06 §Identität).
 * Reihenfolge: Origin (403) → Rate-Limit IP 300/min (429) → Body (400) → Cookie gültig (401) → Rate-Limit
 * Gast 30/min (429) → Gast existiert (401) → nicht gesperrt (Gast oder IP-Schlüssel, 403 BANNED) →
 * optional Turnstile (Claim `tsv`) → JWT 60 s; Session-Cookie wird dabei ggf. rollierend erneuert.
 */
import { type TicketResponse, ticketRequestSchema } from "@quizmaster/shared";
import { NextResponse } from "next/server";
import { ApiError, NO_STORE, readJsonBody } from "../http";
import { assertAllowedOrigin, clientAddress } from "../request-guards";
import { issueRealtimeTicket, needsRenewal } from "../tokens";
import { consumeRateLimit, nowSeconds, readSession, setSessionCookie, verifyTurnstileToken } from "./common";
import type { ApiHandler } from "./route";

const ENDPOINT = "POST /api/realtime/ticket";

export const handleTicketRequest: ApiHandler = async (request, ctx) => {
  assertAllowedOrigin(request.headers, ctx.env);
  const client = clientAddress(request.headers, ctx.env);
  await consumeRateLimit(ctx, ENDPOINT, "ip", client.key);
  const body = await readJsonBody(request, ticketRequestSchema);

  const nowMs = ctx.now();
  const now = new Date(nowMs);
  const nowSec = nowSeconds(nowMs);

  const session = await readSession(request, ctx, nowSec);
  if (session === null) throw new ApiError("UNAUTHORIZED", "Keine gültige Session");
  const guestId = session.sub;
  await consumeRateLimit(ctx, ENDPOINT, "guest", guestId);

  if (!(await ctx.data.repos.guests.touch(guestId, now))) throw new ApiError("UNAUTHORIZED", "Gast unbekannt");

  const ban = await ctx.data.repos.bans.findActiveFor(
    client.resolved ? { guestId, ipKey: client.key } : { guestId },
    now,
  );
  if (ban !== null) {
    ctx.logger.info({ guestId, banKind: ban.kind }, "Ticket für gesperrten Gast abgelehnt");
    throw new ApiError("BANNED", "Gesperrt");
  }

  const turnstileVerifiedAt =
    body.turnstileToken === undefined ? undefined : await verifyTurnstileToken(ctx, body.turnstileToken, client.ip);

  const { ticket } = await issueRealtimeTicket({
    guestId,
    secret: ctx.env.realtimeTicketSecret,
    nowMs: ctx.now(),
    ...(turnstileVerifiedAt === undefined ? {} : { turnstileVerifiedAt }),
  });
  const response = NextResponse.json<TicketResponse>({ ticket }, { headers: { "Cache-Control": NO_STORE } });
  if (needsRenewal(session, nowSec)) await setSessionCookie(response, guestId, ctx, nowSec);
  return response;
};
