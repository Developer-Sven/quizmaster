/**
 * Datensparsamkeit für die Herkunft von Feedback (ADR-058, docs/06 §Datenschutz): Meldungen und Bewertungen tragen den
 * HMAC-IP-Schlüssel für die Schutzautomatik nur `RETENTION.feedbackOriginMs` (30 Tage) – danach entfernt ihn dieser
 * Dienst (erster Lauf kurz nach dem Start, dann stündlich; die Dokumente selbst bleiben bis zu ihrer TTL). Ältere
 * Einträge zählen danach als „IP unbekannt“ und hängen damit zusammen (fail closed, `@quizmaster/db` independence).
 *
 * Läufe überlappen nie; ein Fehler wird geloggt und gezählt (`qm_mongo_errors_total{operation="origin_retention"}`),
 * der nächste Lauf versucht es erneut. Überwacht: Nur ein vollständiger Lauf (Meldungen UND Bewertungen) setzt
 * `qm_origin_retention_last_success_seconds` (Unix-Sekunden, 0 = seit dem Start keiner); der Watchdog meldet
 * (Regel `origin_retention`), wenn der letzte Erfolg – bzw. ohne Erfolg der Start – über 3 h zurückliegt. Ein
 * dauerhafter Fehler (z. B. fehlender Teilindex, an dem der `hint` scheitert) bliebe sonst unter der Mongo-Schwelle.
 */
import { Gauge, type Registry } from "@prometheus-io/client";
import type { Repositories } from "@quizmaster/db";
import { RETENTION } from "@quizmaster/shared/documents";
import type { Logger } from "../logger.ts";
import type { RealtimeMetrics } from "../metrics.ts";
import { withTimeout } from "../registry/util.ts";

/** Abstand der Läufe. */
export const ORIGIN_RETENTION_INTERVAL_MS = 60 * 60_000;
/** Erster Lauf nach dem Start (nicht mitten im Hochfahren). */
export const ORIGIN_RETENTION_FIRST_RUN_MS = 60_000;
/** Frist je Collection und Lauf. */
export const ORIGIN_RETENTION_TIMEOUT_MS = 30_000;
/** Gauge des letzten vollständig erfolgreichen Laufs (Name ist Vertrag mit dem Watchdog). */
export const ORIGIN_RETENTION_SUCCESS_METRIC = "qm_origin_retention_last_success_seconds";

export interface OriginRetentionDeps {
  repos: Pick<Repositories, "reports" | "ratings">;
  clock: { now(): number };
  logger: Logger;
  metrics: Pick<RealtimeMetrics, "recordMongoError" | "registry">;
  intervalMs?: number;
  firstRunMs?: number;
}

/** Gauge je Registry genau einmal (ein erneuter Aufbau der Laufzeit teilt es). */
function successGauge(registry: Registry): Gauge {
  const existing = registry.getSingleMetric(ORIGIN_RETENTION_SUCCESS_METRIC);
  if (existing instanceof Gauge) return existing;
  return new Gauge({
    name: ORIGIN_RETENTION_SUCCESS_METRIC,
    help: "Letzter erfolgreicher Lauf der 30-Tage-Löschung der IP-Schlüssel (Unix-Sekunden, 0 = seit dem Start keiner)",
    registers: [registry],
  });
}

export interface OriginRetentionResult {
  reports: number;
  ratings: number;
}

export interface OriginRetention {
  /** Plant die Läufe (idempotent). */
  start(): void;
  stop(): void;
  /** Ein Lauf jetzt – wirft bei Fehlern (Tests, Diagnose). */
  runOnce(): Promise<OriginRetentionResult>;
}

export function createOriginRetention(deps: OriginRetentionDeps): OriginRetention {
  const log = deps.logger.child({ component: "origin-retention" });
  const intervalMs = deps.intervalMs ?? ORIGIN_RETENTION_INTERVAL_MS;
  const firstRunMs = deps.firstRunMs ?? ORIGIN_RETENTION_FIRST_RUN_MS;
  const lastSuccess = successGauge(deps.metrics.registry);
  let first: NodeJS.Timeout | undefined;
  let interval: NodeJS.Timeout | undefined;
  let running = false;

  const guarded = async (task: Promise<number>): Promise<number> => {
    try {
      return await withTimeout(task, ORIGIN_RETENTION_TIMEOUT_MS, "origin_retention");
    } catch (error) {
      deps.metrics.recordMongoError("origin_retention");
      throw error;
    }
  };

  const runOnce = async (): Promise<OriginRetentionResult> => {
    const before = new Date(deps.clock.now() - RETENTION.feedbackOriginMs);
    const reports = await guarded(deps.repos.reports.forgetOrigins(before));
    const ratings = await guarded(deps.repos.ratings.forgetOrigins(before));
    lastSuccess.set(Math.floor(deps.clock.now() / 1_000));
    if (reports + ratings > 0) {
      log.info({ reports, ratings, before: before.toISOString() }, "Herkunft älterer Meldungen/Bewertungen entfernt");
    }
    return { reports, ratings };
  };

  const tick = () => {
    if (running) return;
    running = true;
    runOnce()
      .catch((error: unknown) => {
        log.error(
          { err: error },
          "Herkunft älterer Meldungen/Bewertungen nicht entfernt – nächster Lauf versucht es erneut",
        );
      })
      .finally(() => {
        running = false;
      });
  };

  return {
    start() {
      if (first !== undefined || interval !== undefined) return;
      first = setTimeout(tick, firstRunMs);
      first.unref();
      interval = setInterval(tick, intervalMs);
      interval.unref();
    },
    stop() {
      clearTimeout(first);
      clearInterval(interval);
      first = undefined;
      interval = undefined;
    },
    runOnce,
  };
}
