/**
 * Prometheus-Metriken für `GET /metrics` (docs/12 §Monitoring, docs/07 §SLOs) mit `@prometheus-io/client`
 * (ADR-031) in einer eigenen Registry je App-Instanz. Labels stammen nur aus festen Listen (Eventnamen der
 * Registry, Fehlercodes, Regel-IDs) – nie aus Client-Daten, sonst explodiert die Kardinalität.
 *
 * Dazu die Grundlage des Lastabwurfs (docs/06 §DDoS 5): Event-Loop-Verzögerung per `monitorEventLoopDelay`
 * in Fenstern zu 5 s (Verzögerung = Tick-Abstand minus Messauflösung); liegt p99 in zwei Fenstern
 * nacheinander über 200 ms, gilt der Server als überlastet.
 */
import { type ELDHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import { LOAD_SHEDDING } from "@quizmaster/shared";

/** Fensterlänge der Event-Loop-Auswertung. */
export const EVENT_LOOP_WINDOW_MS = 5_000;
/** Messauflösung von `monitorEventLoopDelay`. */
export const EVENT_LOOP_RESOLUTION_MS = 20;
/** So viele Fenster in Folge über der Grenze, bevor Lastabwurf greift (robust gegen einzelne Spitzen). */
export const OVERLOAD_WINDOWS = 2;

/** Buckets der Ack-Latenz (SLO `game:answer`: p95 < 10 ms, p99 < 30 ms). */
export const ACK_LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15];

export interface EventLoopMonitor {
  /** p99 der Verzögerung im letzten abgeschlossenen Fenster (ms). */
  p99Ms(): number;
  /** true, solange die Verzögerung über der Lastabwurf-Grenze liegt. */
  overloaded(): boolean;
  /** Wertet das laufende Fenster sofort aus (Tests, Diagnose). */
  sample(): void;
}

/** Stand des Fragenkatalogs für die Gauges `qm_catalog_*` (liefert der Fragen-Service). */
export interface CatalogGaugeSource {
  questions: number;
  usableCategories: number;
  usable: boolean;
}

export interface RealtimeMetrics {
  readonly registry: Registry;
  /** Content-Type für die Antwort von `/metrics`. */
  readonly contentType: string;
  render(): Promise<string>;

  /** Client→Server-Events je Event und Ergebnis (`ok` oder Fehlercode) – Basis für Events/s. */
  readonly events: Counter<"event" | "outcome">;
  /** Zeit vom Eingang bis zum Ack. */
  readonly ackLatency: Histogram<"event">;
  /** Abgelehnte Verbindungen je Grund (`origin`, `flood` oder Fehlercode). */
  readonly connectionsRejected: Counter<"reason">;
  /** Limit-Treffer je Regel-ID (`RATE_LIMITS`, `connections.*`). */
  readonly rateLimitHits: Counter<"rule">;
  readonly validationFailures: Counter<"event">;
  readonly violations: Counter<"reason">;
  readonly violationDisconnects: Counter;
  readonly bans: Counter<"source">;
  readonly mongoErrors: Counter<"operation">;
  readonly changeStreamRestarts: Counter<"stream" | "reason">;
  /** Spiele, die vorzeitig aus technischen Gründen endeten (`load_failed`). */
  readonly gamesAborted: Counter<"reason">;
  /** Spielabschlüsse, die endgültig nicht gespeichert wurden (`invalid`, `overflow`, `shutdown`). */
  readonly gamesLost: Counter<"reason">;

  /** Anzahl aktiver Lobbys (setzt die Lobby-Registry). */
  setActiveLobbies(count: number): void;
  /** Mongo-Fehler zählen; `operation` ist ein fester Name wie `ban_lookup` oder `lobby_snapshot`. */
  recordMongoError(operation: string): void;
  /** Neustart eines Change Streams (Watcher, `onReset`/`onError` von `watchWithResume`). */
  recordChangeStreamRestart(stream: string, reason: string): void;
  /** Quelle der Katalog-Gauges (beim Abruf gelesen); `null` = keine Werte. */
  setCatalogSource(source: (() => CatalogGaugeSource) | null): void;

  readonly eventLoop: EventLoopMonitor;
  start(): void;
  stop(): void;
}

export interface CreateMetricsOptions {
  /** Aktuelle Zahl verbundener Sockets (wird beim Abruf gelesen). */
  socketCount: () => number;
  /** Überlastgrenze p99 in ms (Standard 200, `LOAD_SHEDDING`). */
  overloadThresholdMs?: number;
}

export function createMetrics(options: CreateMetricsOptions): RealtimeMetrics {
  const registry = new Registry();
  const registers = [registry];
  const thresholdMs = options.overloadThresholdMs ?? LOAD_SHEDDING.eventLoopDelayP99Ms;

  new Gauge({
    name: "qm_sockets",
    help: "Verbundene Sockets",
    registers,
    collect() {
      this.set(options.socketCount());
    },
  });
  const lobbies = new Gauge({ name: "qm_lobbies_active", help: "Aktive Lobbys im Speicher", registers });

  const events = new Counter({
    name: "qm_socket_events_total",
    help: "Client-Events je Event und Ergebnis (ok oder Fehlercode)",
    labelNames: ["event", "outcome"] as const,
    registers,
  });
  const ackLatency = new Histogram({
    name: "qm_ack_latency_seconds",
    help: "Zeit vom Eingang eines Events bis zum Ack",
    labelNames: ["event"] as const,
    buckets: ACK_LATENCY_BUCKETS,
    registers,
  });
  const connectionsRejected = new Counter({
    name: "qm_connections_rejected_total",
    help: "Abgelehnte Verbindungen je Grund",
    labelNames: ["reason"] as const,
    registers,
  });
  const rateLimitHits = new Counter({
    name: "qm_rate_limit_hits_total",
    help: "Limit-Treffer je Regel",
    labelNames: ["rule"] as const,
    registers,
  });
  const validationFailures = new Counter({
    name: "qm_validation_failures_total",
    help: "Ungültige Payloads je Event",
    labelNames: ["event"] as const,
    registers,
  });
  const violations = new Counter({
    name: "qm_violations_total",
    help: "Verstöße (Limits, Validierung, unbekannte Events, fehlendes Ack)",
    labelNames: ["reason"] as const,
    registers,
  });
  const violationDisconnects = new Counter({
    name: "qm_violation_disconnects_total",
    help: "Wegen Verstößen getrennte Sockets",
    registers,
  });
  const bans = new Counter({
    name: "qm_bans_total",
    help: "Ausgesprochene Sperren je Quelle",
    labelNames: ["source"] as const,
    registers,
  });
  const mongoErrors = new Counter({
    name: "qm_mongo_errors_total",
    help: "MongoDB-Fehler je Operation",
    labelNames: ["operation"] as const,
    registers,
  });
  const changeStreamRestarts = new Counter({
    name: "qm_change_stream_restarts_total",
    help: "Neustarts von Change Streams je Stream und Grund",
    labelNames: ["stream", "reason"] as const,
    registers,
  });

  const gamesAborted = new Counter({
    name: "qm_games_aborted_total",
    help: "Vorzeitig aus technischen Gründen beendete Spiele je Grund",
    labelNames: ["reason"] as const,
    registers,
  });
  const gamesLost = new Counter({
    name: "qm_games_lost_total",
    help: "Endgültig nicht gespeicherte Spielabschlüsse je Grund (Statistik fehlt)",
    labelNames: ["reason"] as const,
    registers,
  });

  let catalogSource: (() => CatalogGaugeSource) | null = null;
  const readCatalog = (): CatalogGaugeSource | null => {
    try {
      return catalogSource?.() ?? null;
    } catch {
      return null;
    }
  };
  new Gauge({
    name: "qm_catalog_questions",
    help: "Spielbare Fragen im Pool des Realtime-Servers",
    registers,
    collect() {
      const catalog = readCatalog();
      if (catalog !== null) this.set(catalog.questions);
    },
  });
  new Gauge({
    name: "qm_catalog_usable_categories",
    help: "Spielbare Kategorien mit mindestens einer Frage im Pool",
    registers,
    collect() {
      const catalog = readCatalog();
      if (catalog !== null) this.set(catalog.usableCategories);
    },
  });
  new Gauge({
    name: "qm_catalog_usable",
    help: "1 = der Fragenkatalog reicht für ein Spiel (sonst endet jedes Spiel sofort)",
    registers,
    collect() {
      const catalog = readCatalog();
      if (catalog !== null) this.set(catalog.usable ? 1 : 0);
    },
  });

  new Gauge({
    name: "qm_process_memory_bytes",
    help: "Speicher des Prozesses (heap_used, heap_total, rss, external)",
    labelNames: ["type"] as const,
    registers,
    collect() {
      const usage = process.memoryUsage();
      this.set({ type: "heap_used" }, usage.heapUsed);
      this.set({ type: "heap_total" }, usage.heapTotal);
      this.set({ type: "rss" }, usage.rss);
      this.set({ type: "external" }, usage.external);
    },
  });

  const eventLoopDelay = new Gauge({
    name: "qm_event_loop_delay_seconds",
    help: "Event-Loop-Verzögerung im letzten 5-s-Fenster (p50, p99, max)",
    labelNames: ["quantile"] as const,
    registers,
  });
  const overloadedGauge = new Gauge({
    name: "qm_overloaded",
    help: "1 = Lastabwurf aktiv (neue Verbindungen/Lobbys → SERVER_BUSY)",
    registers,
  });

  let histogram: ELDHistogram | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastP99Ms = 0;
  let windowsOver = 0;
  let overloaded = false;

  // Node zeichnet den Abstand zwischen zwei Timer-Ticks auf (Auflösung + Verzögerung) → Auflösung abziehen.
  // Nach `reset()` fehlt der erste Tick eines Fensters (Node setzt den Bezugszeitpunkt zurück).
  const resolutionNs = EVENT_LOOP_RESOLUTION_MS * 1e6;
  const delayNs = (value: number) => Math.max(0, value - resolutionNs);

  const sample = () => {
    if (histogram === undefined) return;
    // Leeres Fenster (z. B. direkt nach einem Reset) liefert keine Aussage – Zustand beibehalten.
    if (histogram.count === 0) return;
    const p50 = delayNs(histogram.percentile(50));
    const p99 = delayNs(histogram.percentile(99));
    const max = delayNs(histogram.max);
    histogram.reset();
    lastP99Ms = p99 / 1e6;
    eventLoopDelay.set({ quantile: "0.5" }, p50 / 1e9);
    eventLoopDelay.set({ quantile: "0.99" }, p99 / 1e9);
    eventLoopDelay.set({ quantile: "max" }, max / 1e9);
    windowsOver = lastP99Ms > thresholdMs ? windowsOver + 1 : 0;
    overloaded = windowsOver >= OVERLOAD_WINDOWS;
    overloadedGauge.set(overloaded ? 1 : 0);
  };

  return {
    registry,
    contentType: registry.contentType,
    render: () => registry.metrics(),
    events,
    ackLatency,
    connectionsRejected,
    rateLimitHits,
    validationFailures,
    violations,
    violationDisconnects,
    bans,
    mongoErrors,
    changeStreamRestarts,
    gamesAborted,
    gamesLost,
    setActiveLobbies(count) {
      lobbies.set(count);
    },
    recordMongoError(operation) {
      mongoErrors.inc({ operation });
    },
    recordChangeStreamRestart(stream, reason) {
      changeStreamRestarts.inc({ stream, reason });
    },
    setCatalogSource(source) {
      catalogSource = source;
    },
    eventLoop: {
      p99Ms: () => lastP99Ms,
      overloaded: () => overloaded,
      sample,
    },
    start() {
      if (histogram !== undefined) return;
      histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
      histogram.enable();
      timer = setInterval(sample, EVENT_LOOP_WINDOW_MS);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      histogram?.disable();
      histogram = undefined;
    },
  };
}
