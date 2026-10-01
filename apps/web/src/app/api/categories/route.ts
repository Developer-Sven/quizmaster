/** `GET /api/categories` – spielbare Kategorien, nur öffentliche Felder (Handler: lib/server/api/public.ts). */
import { handleCategoriesRequest } from "../../../lib/server/api/public";
import { apiRoute } from "../../../lib/server/api/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = apiRoute("GET /api/categories", handleCategoriesRequest);
