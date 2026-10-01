/** `POST /api/realtime/ticket` – Socket-Ticket (Handler: lib/server/api/ticket.ts). */
import { apiRoute } from "../../../../lib/server/api/route";
import { handleTicketRequest } from "../../../../lib/server/api/ticket";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = apiRoute("POST /api/realtime/ticket", handleTicketRequest);
