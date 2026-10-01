/**
 * Öffentliche GET-Endpunkte: `GET /api/categories` (spielbare Kategorien, CDN-cachebar, IP 60/min) und
 * `GET /api/health` (nur `{ ok }`, IP 60/min, no-store; 503 wenn die Datenbank nicht antwortet).
 */
import type { HealthResponse } from "@quizmaster/shared";
import { NextResponse } from "next/server";
import type { CategoriesResponse } from "../api-schemas";
import { noStoreJson, retryAfterSeconds } from "../http";
import { clientAddress } from "../request-guards";
import { consumeRateLimit } from "./common";
import type { ApiHandler } from "./route";

/** docs/07 §Caching: Cloudflare-Edge cacht 5 min, liefert danach bis 1 h veraltet aus. */
export const CATEGORIES_CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=3600";

export const handleCategoriesRequest: ApiHandler = async (request, ctx) => {
  await consumeRateLimit(ctx, "GET /api/categories", "ip", clientAddress(request.headers, ctx.env).key);
  const categories = await ctx.categories.listPlayable();
  return NextResponse.json<CategoriesResponse>(
    { categories },
    { headers: { "Cache-Control": CATEGORIES_CACHE_CONTROL } },
  );
};

/** docs/06: Health antwortet immer nur mit `{ ok }` – auch bei 429 (mit `Retry-After`) und 503. */
export const handleHealthRequest: ApiHandler = async (request, ctx) => {
  const limit = await ctx.limiters.consume("GET /api/health", "ip", clientAddress(request.headers, ctx.env).key);
  if (!limit.ok) {
    const response = noStoreJson<HealthResponse>({ ok: false }, { status: limit.reason === "limited" ? 429 : 503 });
    if (limit.reason === "limited") response.headers.set("Retry-After", String(retryAfterSeconds(limit.retryAfterMs)));
    return response;
  }
  const ok = await ctx.health.check();
  return noStoreJson<HealthResponse>({ ok }, { status: ok ? 200 : 503 });
};

/** Health ohne Kontext (Env ungültig, Kontext nicht baubar): nie Details, immer 503. */
export function healthUnavailable(): Response {
  return noStoreJson<HealthResponse>({ ok: false }, { status: 503 });
}
