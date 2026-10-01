/**
 * Event-Registry und -Wrapper (docs/05 §Ack-Format, docs/06 Invarianten 5/6, docs/02 §Fehlerbehandlung).
 * Jedes Client-Event eines Sockets läuft durch genau diese Pipeline:
 *
 * 1. Fallback-Limit je Socket (30/s) – zuerst, damit auch Fluten ungültiger/unbekannter Events billig bleiben.
 * 2. Event bekannt und registriert? Sonst Verstoß (`unknown_event`).
 * 3. Ack-Callback Pflicht (sonst Verstoß `missing_ack`), genau ein Payload-Argument.
 * 4. Payload validieren (`parseClientPayload`, strictObject) → `VALIDATION_FAILED` + Verstoß.
 * 5. Shutdown: `lobby:create` → `SERVER_BUSY` (keine neuen Lobbys).
 * 6. Rate-Limits aus `RATE_LIMITS` (Scope socket/guest/ip; `consume: "failure"` erst prüfen, nach einem
 *    Fehlschlag verbrauchen) → `RATE_LIMITED` mit `retryAfterMs` (+ Verstoß, wenn die Regel es verlangt).
 * 7. Handler mit Kontext; Ack genau einmal: Rückgabewert → `{ ok: true, data }` (gegen das Ack-Schema geprüft),
 *    `ProtocolError` → Code, alles andere → `INTERNAL` + Log mit `requestId`; Frist 15 s → `INTERNAL`.
 * 8. Metriken: Events je Ergebnis, Ack-Latenz, Validierungsfehler, Limit-Treffer.
 */
import {
  type AckResponse,
  ackError,
  ackFromError,
  ackOk,
  CLIENT_EVENT_NAMES,
  CLIENT_EVENTS,
  type ClientEventName,
  type ClientEventPayload,
  type ErrorCode,
  isClientEventName,
  isProtocolError,
  parseClientPayload,
  type RateLimitRule,
} from "@quizmaster/shared";
import type { z } from "zod";
import type { Logger, SecurityLog } from "../logger.ts";
import { guestTag } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import { UNKNOWN_IP_KEY } from "../services/connections.ts";
import type { RateLimitService } from "../services/rate-limit.ts";
import type {
  AckSent,
  AppSocket,
  Clock,
  EventContext,
  EventHandler,
  Lifecycle,
  RegisterEventOptions,
} from "./types.ts";
import type { ViolationTracker } from "./violations.ts";

/** Höchstdauer eines Handlers bis zum Ack; danach `INTERNAL` (ein Ack kommt immer). */
export const HANDLER_TIMEOUT_MS = 15_000;

/** Events, die ab `stop()` sofort mit `SERVER_BUSY` beantwortet werden (keine neuen Lobbys). */
export const BLOCKED_DURING_SHUTDOWN: ReadonlySet<ClientEventName> = new Set<ClientEventName>(["lobby:create"]);

/** Codes, die bei `consume: "failure"` NICHT als Fehlversuch zählen (Server-Zustände statt Client-Fehler). */
const NOT_A_FAILED_ATTEMPT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "INTERNAL",
  "SERVER_BUSY",
  "RATE_LIMITED",
  "UPDATE_REQUIRED",
  "LOBBY_CREATION_DISABLED",
  "TURNSTILE_REQUIRED",
]);

/** Standard für Regeln mit `consume: "failure"`: jede fachliche Ablehnung zählt als Fehlversuch. */
export function isFailedAttempt(code: ErrorCode): boolean {
  return !NOT_A_FAILED_ATTEMPT.has(code);
}

const ACK_SENT = Object.freeze({}) as AckSent;

/** Label für Metriken: nur Eventnamen der Registry, alles andere „unknown“ (Kardinalität). */
type EventLabel = ClientEventName | "unknown";

interface Registration {
  readonly event: ClientEventName;
  invoke(payload: unknown, ctx: EventContext): unknown;
  readonly attemptRules: readonly RateLimitRule[];
  readonly failureRules: readonly RateLimitRule[];
  countsAsFailure(code: ErrorCode): boolean;
}

export interface EventRegistry {
  /** Siehe `ModuleContext.registerEvent`. */
  register<E extends ClientEventName>(event: E, handler: EventHandler<E>, options?: RegisterEventOptions): boolean;
  has(event: ClientEventName): boolean;
  registeredEvents(): ClientEventName[];
  /** Events aus `CLIENT_EVENTS` ohne Handler (`devOnly` nur mit DEV_BOTS_ENABLED). */
  missingHandlers(): ClientEventName[];
  /** Wirksame Zeitfenster-Limits eines Events (Invariante 6). */
  limitsOf(event: ClientEventName): readonly RateLimitRule[];
  /** Hängt die Pipeline an einen authentifizierten Socket. */
  attach(socket: AppSocket): void;
}

export interface EventRegistryDeps {
  devBotsEnabled: boolean;
  clock: Clock;
  logger: Logger;
  metrics: RealtimeMetrics;
  security: SecurityLog;
  rateLimit: RateLimitService;
  violations: ViolationTracker;
  lifecycle: Lifecycle;
  handlerTimeoutMs?: number;
}

/** Fortlaufende Request-IDs: kurzer Zufallspräfix je Prozess + Zähler (billiger als eine UUID je Event). */
function createRequestIds(): () => string {
  const prefix = crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36) ?? "0";
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter.toString(36)}`;
  };
}

/** Kurze Beschreibung von zod-Fehlern ohne Eingabewerte (nur Pfad + Fehlerart). */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join(".") || "(payload)"}: ${issue.code}`)
    .join("; ");
}

function limitKey(rule: RateLimitRule, socket: AppSocket): string {
  switch (rule.scope) {
    case "socket":
      return socket.id;
    case "guest":
      return socket.data.guestId;
    case "ip":
      return socket.data.ipKey ?? UNKNOWN_IP_KEY;
    case "player_question":
      throw new Error(`Regel „${rule.id}“ (player_question) setzt die Engine durch`);
  }
}

export function createEventRegistry(deps: EventRegistryDeps): EventRegistry {
  const registrations = new Map<ClientEventName, Registration>();
  const handlerTimeoutMs = deps.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS;
  const nextRequestId = createRequestIds();
  const fallbackRule = deps.rateLimit.rule("socket.any-event");
  const warnedMissing = new Set<ClientEventName>();

  const isAvailable = (event: ClientEventName) => deps.devBotsEnabled || !CLIENT_EVENTS[event].devOnly;

  const limitsOf = (event: ClientEventName) => deps.rateLimit.rulesFor(event).filter((rule) => rule.kind === "rate");

  const limitHit = (rule: RateLimitRule) => {
    deps.metrics.rateLimitHits.inc({ rule: rule.id });
    deps.security.record("limit_hit", rule.id);
  };

  const dispatch = async (socket: AppSocket, socketLog: Logger, rawEvent: unknown, args: unknown[]) => {
    const startedAt = performance.now();
    const receivedAt = deps.clock.now();
    const known = isClientEventName(rawEvent) ? rawEvent : null;
    const label: EventLabel = known ?? "unknown";
    const last = args.at(-1);
    const ackFn = typeof last === "function" ? (last as (response: AckResponse<unknown>) => void) : null;
    const requestId = nextRequestId();
    const log = socketLog.child({ requestId, event: label });
    let acked = false;

    /** Sendet das Ack genau einmal und zählt das Ergebnis. */
    const respond = (response: AckResponse<unknown>): boolean => {
      if (acked) return false;
      acked = true;
      deps.metrics.events.inc({ event: label, outcome: response.ok ? "ok" : response.error.code });
      deps.metrics.ackLatency.observe({ event: label }, (performance.now() - startedAt) / 1_000);
      ackFn?.(response);
      return true;
    };

    const violation = (reason: Parameters<ViolationTracker["record"]>[1]) => deps.violations.record(socket, reason);

    const rejectLimited = async (hits: readonly { rule: RateLimitRule; retryAfterMs: number }[]) => {
      for (const hit of hits) limitHit(hit.rule);
      const retryAfterMs = Math.max(...hits.map((hit) => hit.retryAfterMs));
      respond(ackError("RATE_LIMITED", "Zu viele Anfragen", retryAfterMs));
      if (hits.some((hit) => hit.rule.countsAsViolation)) await violation("rate_limit");
    };

    try {
      // 1. Fallback-Limit je Socket
      const fallback = await deps.rateLimit.consume(fallbackRule, socket.id);
      if (!fallback.allowed) {
        await rejectLimited([{ rule: fallbackRule, retryAfterMs: fallback.retryAfterMs }]);
        return;
      }

      // 2. Bekanntes, registriertes Event?
      const registration = known === null ? undefined : registrations.get(known);
      if (known === null || registration === undefined) {
        if (known !== null && isAvailable(known)) {
          // Bekanntes Event ohne Handler: Server-Lücke (nur Entwicklung/Test), kein Client-Verstoß.
          if (!warnedMissing.has(known)) log.error("Kein Handler für dieses Event registriert");
          warnedMissing.add(known);
          respond(ackError("INTERNAL", "Kein Handler"));
          return;
        }
        respond(ackError("VALIDATION_FAILED", "Unbekanntes Event"));
        await violation("unknown_event");
        return;
      }
      const event = registration.event;

      // 3. Ack-Callback Pflicht, genau ein Payload
      if (ackFn === null) {
        deps.metrics.events.inc({ event, outcome: "missing_ack" });
        await violation("missing_ack");
        return;
      }
      if (args.length !== 2) {
        deps.metrics.validationFailures.inc({ event });
        deps.security.record("validation_failed", event);
        respond(ackError("VALIDATION_FAILED", "Genau ein Payload erwartet"));
        await violation("validation");
        return;
      }

      // 4. Payload validieren
      const parsed = parseClientPayload(event, args[0]);
      if (!parsed.success) {
        deps.metrics.validationFailures.inc({ event });
        deps.security.record("validation_failed", event);
        respond(ackError("VALIDATION_FAILED", describeIssues(parsed.error)));
        await violation("validation");
        return;
      }

      // 5. Keine neuen Lobbys im Shutdown
      if (deps.lifecycle.isShuttingDown() && BLOCKED_DURING_SHUTDOWN.has(event)) {
        respond(ackError("SERVER_BUSY", "Server startet neu"));
        return;
      }

      // 6. Rate-Limits: gesperrte Fehlversuchs-Zähler, dann Versuchs-Zähler
      for (const rule of registration.failureRules) {
        const state = await deps.rateLimit.peek(rule, limitKey(rule, socket));
        if (!state.allowed) {
          await rejectLimited([{ rule, retryAfterMs: state.retryAfterMs }]);
          return;
        }
      }
      const decisions = await Promise.all(
        registration.attemptRules.map(async (rule) => ({
          rule,
          decision: await deps.rateLimit.consume(rule, limitKey(rule, socket)),
        })),
      );
      const hits = decisions.filter((entry) => !entry.decision.allowed);
      if (hits.length > 0) {
        await rejectLimited(hits.map((hit) => ({ rule: hit.rule, retryAfterMs: hit.decision.retryAfterMs })));
        return;
      }

      // 7. Handler
      const ackSchema: z.ZodType = CLIENT_EVENTS[event].ack;
      const sendSuccess = (data: unknown) => {
        const checked = ackSchema.safeParse(data);
        if (checked.success) return respond(ackOk(checked.data));
        log.error({ issues: describeIssues(checked.error) }, "Ack-Daten verletzen das Ack-Schema");
        return respond(ackError("INTERNAL", "Interner Fehler"));
      };
      const ctx: EventContext = {
        event,
        socket,
        guestId: socket.data.guestId,
        ipKey: socket.data.ipKey,
        requestId,
        now: receivedAt,
        log,
        ack(data) {
          sendSuccess(data);
          return ACK_SENT;
        },
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), handlerTimeoutMs);
      });
      const run = (async () => registration.invoke(parsed.data, ctx))();
      const settled = run.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const result = await Promise.race([settled, timeout]);
      clearTimeout(timer);

      if (result === "timeout") {
        if (respond(ackError("INTERNAL", "Zeitüberschreitung"))) {
          log.error({ timeoutMs: handlerTimeoutMs }, "Handler hat die Frist überschritten");
        }
        void settled.then((late) => {
          if (late.ok) log.warn("Handler nach Ablauf der Frist beendet");
          else log.error({ err: late.error }, "Handler nach Ablauf der Frist fehlgeschlagen");
        });
        return;
      }

      if (result.ok) {
        if (result.value === ACK_SENT) {
          // Marke ohne ctx.ack() kann es nicht geben – trotzdem nie ohne Ack enden.
          if (!acked) respond(ackError("INTERNAL", "Interner Fehler"));
        } else if (acked) {
          log.warn("Handler lieferte Daten nach ctx.ack() – ignoriert");
        } else {
          sendSuccess(result.value);
        }
        return;
      }

      const error = result.error;
      if (isProtocolError(error)) {
        if (!respond(ackFromError(error))) log.warn({ code: error.code }, "Fachlicher Fehler nach dem Ack – ignoriert");
        if (registration.failureRules.length > 0 && registration.countsAsFailure(error.code)) {
          await Promise.all(
            registration.failureRules.map(async (rule) => {
              const decision = await deps.rateLimit.consume(rule, limitKey(rule, socket));
              if (!decision.allowed) limitHit(rule);
            }),
          );
        }
        return;
      }
      log.error({ err: error }, "Unerwarteter Fehler im Handler");
      respond(ackError("INTERNAL", "Interner Fehler"));
    } catch (error) {
      log.error({ err: error }, "Event-Verarbeitung fehlgeschlagen");
      respond(ackError("INTERNAL", "Interner Fehler"));
    }
  };

  return {
    register(event, handler, options = {}) {
      if (!isClientEventName(event)) throw new Error(`Unbekanntes Event „${String(event)}“`);
      if (registrations.has(event)) throw new Error(`Event „${event}“ ist bereits registriert`);
      if (!isAvailable(event)) return false;
      const rules = limitsOf(event);
      if (rules.length === 0) throw new Error(`Event „${event}“ hat kein Rate-Limit (docs/06 Invariante 6)`);
      registrations.set(event, {
        event,
        // Payload ist gegen das Schema von `event` validiert, der Kontext für `event` gebaut.
        invoke: (payload, ctx) =>
          handler(payload as ClientEventPayload<typeof event>, ctx as EventContext<typeof event>),
        attemptRules: rules.filter((rule) => rule.consume === "attempt"),
        failureRules: rules.filter((rule) => rule.consume === "failure"),
        countsAsFailure: options.countsAsFailure ?? isFailedAttempt,
      });
      return true;
    },
    has: (event) => registrations.has(event),
    registeredEvents: () => [...registrations.keys()],
    missingHandlers: () => CLIENT_EVENT_NAMES.filter((event) => isAvailable(event) && !registrations.has(event)),
    limitsOf,
    attach(socket) {
      const socketLog = deps.logger.child({ guest: guestTag(socket.data.guestId) });
      socket.onAny((event: unknown, ...args: unknown[]) => {
        dispatch(socket, socketLog, event, args).catch((error: unknown) => {
          socketLog.error({ err: error }, "Event-Pipeline fehlgeschlagen");
        });
      });
    },
  };
}
