/** `GET /api/health` – `{ ok }` ohne Details (Handler: lib/server/api/public.ts). */
import { handleHealthRequest, healthUnavailable } from "../../../lib/server/api/public";
import { apiRoute } from "../../../lib/server/api/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = apiRoute("GET /api/health", handleHealthRequest, { onUnexpected: healthUnavailable });
