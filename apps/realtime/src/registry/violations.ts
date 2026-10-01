/**
 * Verstöße (docs/06 §Rate-Limits, letzte Zeilen): Limit-Treffer, Validierungsfehler, unbekannte Events und
 * Events ohne Ack zählen je Socket. Mehr als 10 pro Minute → Socket trennen; mehr als 3 solcher Trennungen
 * eines Gasts in 10 Minuten (Mongo-Zähler) → Gast 15 Minuten sperren (`bans`) und alle seine Sockets trennen.
 */
import type { Logger, SecurityLog } from "../logger.ts";
import { guestTag } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import type { BansService } from "../services/bans.ts";
import type { RateLimitService } from "../services/rate-limit.ts";
import type { AppSocket } from "./types.ts";

export const VIOLATION_REASONS = ["rate_limit", "validation", "unknown_event", "missing_ack"] as const;
export type ViolationReason = (typeof VIOLATION_REASONS)[number];

/** Fester Grund der Sperre in `bans.reason`. */
export const VIOLATION_BAN_REASON = "violations";

export interface ViolationTracker {
  /** Zählt einen Verstoß; trennt bzw. sperrt bei Überschreitung. Wirft nie (Fehler werden geloggt). */
  record(socket: AppSocket, reason: ViolationReason): Promise<void>;
}

export interface ViolationTrackerDeps {
  rateLimit: RateLimitService;
  bans: BansService;
  metrics: RealtimeMetrics;
  security: SecurityLog;
  logger: Logger;
}

export function createViolationTracker(deps: ViolationTrackerDeps): ViolationTracker {
  const violationRule = deps.rateLimit.rule("socket.violations");
  const disconnectRule = deps.rateLimit.rule("guest.violation-disconnects");
  const disconnected = new WeakSet<AppSocket>();

  const escalate = async (guestId: string) => {
    const decision = await deps.rateLimit.consume(disconnectRule, guestId);
    if (decision.allowed || disconnectRule.onExceed.action !== "ban_guest") return;
    const durationSec = disconnectRule.onExceed.banDurationSec;
    await deps.bans.banGuest(guestId, { durationSec, reason: VIOLATION_BAN_REASON });
    deps.metrics.bans.inc({ source: VIOLATION_BAN_REASON });
    deps.security.record("ban", VIOLATION_BAN_REASON);
    deps.logger.warn({ guest: guestTag(guestId), durationSec }, "Gast wegen wiederholter Verstöße gesperrt");
  };

  return {
    async record(socket, reason) {
      deps.metrics.violations.inc({ reason });
      deps.security.record("violation", reason);
      if (disconnected.has(socket) || !socket.connected) return;
      try {
        const decision = await deps.rateLimit.consume(violationRule, socket.id);
        if (decision.allowed || disconnected.has(socket)) return;
        disconnected.add(socket);
        const { guestId } = socket.data;
        deps.metrics.violationDisconnects.inc();
        deps.security.record("violation_disconnect", reason);
        deps.logger.warn({ guest: guestTag(guestId), reason }, "Socket wegen Verstößen getrennt");
        socket.disconnect(true);
        await escalate(guestId);
      } catch (error) {
        deps.logger.error({ err: error }, "Verstoß-Behandlung fehlgeschlagen");
      }
    },
  };
}
