/** `POST /api/session` – Gast-Session anlegen/weiterverwenden (Handler: lib/server/api/session.ts). */

import { apiRoute } from "../../../lib/server/api/route";
import { handleSessionRequest } from "../../../lib/server/api/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = apiRoute("POST /api/session", handleSessionRequest);
