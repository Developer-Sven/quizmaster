/**
 * Watchdog (docs/12 §Monitoring & Alarme, ADR-024: pm2-App `quizmaster-watchdog`, Bundle `dist/watchdog.mjs`).
 * Prüft alle 30 s Web `GET /api/health`, Realtime `GET /healthz` und `GET /metrics` (Bearer `METRICS_TOKEN`) über
 * Loopback und meldet Störungen an `ALERT_WEBHOOK_URL` – ohne URL nur ins Log (pm2-Log, Level `warn`).
 *
 * Alarme (Schwellen in `WATCHDOG_THRESHOLDS`):
 * | Regel | Auslöser |
 * |---|---|
 * | `web_health`, `realtime_health` | Health down > 2 min (200 mit `ok: false`, 5xx, keine Antwort; 429 = lebt) |
 * | `event_loop` | Event-Loop-p99 > 200 ms für 5 min (alle 5-s-Fenster laut `qm_event_loop_p99_seconds`) |
 * | `error_rate` | > 1 % der Client-Events mit `INTERNAL` in 5 min (ab 200 Events) |
 * | `limit_spike` | ≥ 200 Limit-Treffer in 5 min (`qm_rate_limit_hits_total`) – Angriff? |
 * | `change_stream` | ≥ 3 Change-Stream-Neustarts in 15 min |
 * | `mongo` | ≥ 3 Verbindungsfehler (`heartbeat`, `pool_cleared`) oder ≥ 10 sonstige Mongo-Fehler in 5 min |
 * | `restart_loop` | ≥ 3 Neustarts von Realtime in 15 min (`qm_process_start_time_seconds`) |
 * | `metrics` | `/metrics` 5 min lang nicht lesbar, obwohl `/healthz` antwortet (z. B. 401 → Token prüfen) |
 *
 * Entprellung: eine Regel meldet erst, wenn ihre Bedingung die Haltezeit erfüllt (Health 2 min, Event-Loop
 * 5 min); Zählerregeln werten ein gleitendes Fenster aus. Cooldown: höchstens ein Alarm je Regel in 15 min
 * (ein unterdrückter Alarm bekommt auch keine Entwarnung); bei anhaltender Störung eine Erinnerung je Stunde.
 * Entwarnung, sobald die Bedingung nicht mehr gilt. Nutzlast wie `infra/ops/alert.sh` ({content, text},
 * Discord und Slack; @everyone/@here/@channel entschärft). Die Webhook-URL (enthält das Token) und der
 * Metrik-Token werden nie geloggt.
 *
 * Env (`watchdogProcessEnv`, packages/shared/src/env/resolve.ts): WEB_HEALTH_URL, REALTIME_HEALTH_URL,
 * REALTIME_METRICS_URL, METRICS_TOKEN, optional ALERT_WEBHOOK_URL, APP_ORIGIN, LOG_LEVEL, NODE_ENV.
 * SIGINT/SIGTERM: laufende Prüfung abbrechen, Logs schreiben, Exit 0 (pm2 `kill_timeout` 5 s).
 */
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { z } from "zod";
import { createLogger, type Logger } from "./logger.ts";

/** Abstand der Prüfungen (docs/12: alle 30 s). */
export const WATCHDOG_INTERVAL_MS = 30_000;
/** Frist je HTTP-Anfrage an Web/Realtime. */
export const WATCHDOG_REQUEST_TIMEOUT_MS = 5_000;
/** Frist der Webhook-Zustellung. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Höchstens so lange wartet der Shutdown auf eine laufende Prüfung (pm2 `kill_timeout` 5 s). */
export const WATCHDOG_STOP_GRACE_MS = 3_000;

/** Schwellen und Fenster der Alarmregeln (docs/12 §Alarme). */
export const WATCHDOG_THRESHOLDS = {
  /** Health down > 2 min. */
  healthDownForMs: 120_000,
  /** Event-Loop-p99 über dieser Grenze (Sekunden) … */
  eventLoopP99Seconds: 0.2,
  /** … für so lange. */
  eventLoopForMs: 300_000,
  /** Fehlerrate (Anteil `INTERNAL` an allen Client-Events) über … */
  errorRate: 0.01,
  errorRateWindowMs: 300_000,
  /** … erst ab so vielen Events im Fenster (sonst wären 2 von 100 schon ein Alarm). */
  errorRateMinEvents: 200,
  /** Limit-Treffer im Fenster ab dieser Zahl = Spitze. */
  limitSpikeHits: 200,
  limitSpikeWindowMs: 300_000,
  /** Change-Stream-Neustarts im Fenster ab dieser Zahl = „wiederholt abgebrochen“. */
  changeStreamRestarts: 3,
  changeStreamWindowMs: 900_000,
  /** Mongo-Verbindungsfehler (`heartbeat`, `pool_cleared`) bzw. sonstige Mongo-Fehler im Fenster. */
  mongoConnectionErrors: 3,
  mongoOtherErrors: 10,
  mongoWindowMs: 300_000,
  /** Neustarts von Realtime im Fenster ab dieser Zahl = Neustart-Schleife. */
  restarts: 3,
  restartWindowMs: 900_000,
  /** `/metrics` so lange nicht lesbar (bei gesundem `/healthz`). */
  metricsDownForMs: 300_000,
  /** Mindestabstand zweier Alarme derselben Regel. */
  cooldownMs: 900_000,
  /** Erinnerung, solange eine Störung anhält. */
  repeatMs: 3_600_000,
  /** Nach einer gescheiterten Zustellung erst so spät erneut versuchen. */
  retryNotifyMs: 120_000,
} as const;

export type WatchdogThresholds = { readonly [K in keyof typeof WATCHDOG_THRESHOLDS]: number };

/** Mongo-Operationen, die Verbindungsprobleme bedeuten (app.ts: Treiber-Ereignisse). */
const MONGO_CONNECTION_OPERATIONS: ReadonlySet<string> = new Set(["heartbeat", "pool_cleared"]);

// ── Env ───────────────────────────────────────────────────────────────────────────────────────────────

const httpUrl = z.url({ protocol: /^https?$/, error: "http(s)-URL erwartet" });
const optionalString = (schema: z.ZodType<string>) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const watchdogEnvSchema = z.object({
  NODE_ENV: z.enum(["production", "development", "test"]).default("production"),
  WEB_HEALTH_URL: httpUrl,
  REALTIME_HEALTH_URL: httpUrl,
  REALTIME_METRICS_URL: httpUrl,
  METRICS_TOKEN: z.string().min(32, "mindestens 32 Zeichen"),
  ALERT_WEBHOOK_URL: optionalString(z.url({ protocol: /^https$/, error: "https-URL erwartet" })),
  APP_ORIGIN: optionalString(z.url({ protocol: /^https?$/, error: "http(s)-URL erwartet" })),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type WatchdogEnv = z.output<typeof watchdogEnvSchema>;

/** Liest die Env; Probleme nennen nur Schlüssel und Regel, nie Werte. */
export function parseWatchdogEnv(
  source: Readonly<Record<string, string | undefined>>,
): { ok: true; env: WatchdogEnv } | { ok: false; problems: string[] } {
  const parsed = watchdogEnvSchema.safeParse(source);
  if (parsed.success) return { ok: true, env: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(env)"}: ${issue.message}`),
  };
}

// ── Prometheus-Text ────────────────────────────────────────────────────────────────────────────────

export interface MetricSample {
  name: string;
  labels: Readonly<Record<string, string>>;
  value: number;
}

const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+-?\d+)?$/;
const LABEL_PAIR = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"\s*,?\s*/y;

function unescapeLabel(value: string): string {
  return value.replace(/\\(.)/g, (_match, char: string) => (char === "n" ? "\n" : char));
}

function parseNumber(raw: string): number | null {
  if (raw === "+Inf") return Number.POSITIVE_INFINITY;
  if (raw === "-Inf") return Number.NEGATIVE_INFINITY;
  if (raw === "NaN") return Number.NaN;
  const value = Number(raw);
  return Number.isNaN(value) ? null : value;
}

/** Prometheus-Textformat 0.0.4 → Samples (Kommentare und ungültige Zeilen werden übersprungen). */
export function parsePrometheusText(text: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = SAMPLE_LINE.exec(line);
    if (match === null) continue;
    const [, name, labelText, rawValue] = match;
    if (name === undefined || rawValue === undefined) continue;
    const value = parseNumber(rawValue);
    if (value === null) continue;
    const labels: Record<string, string> = {};
    if (labelText !== undefined && labelText !== "") {
      LABEL_PAIR.lastIndex = 0;
      let pair = LABEL_PAIR.exec(labelText);
      while (pair !== null) {
        const [, key, labelValue] = pair;
        if (key !== undefined && labelValue !== undefined) labels[key] = unescapeLabel(labelValue);
        if (LABEL_PAIR.lastIndex >= labelText.length) break;
        pair = LABEL_PAIR.exec(labelText);
      }
    }
    samples.push({ name, labels, value });
  }
  return samples;
}

type LabelFilter = (labels: Readonly<Record<string, string>>) => boolean;

function seriesKey(sample: MetricSample): string {
  const labels = Object.entries(sample.labels)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `${sample.name}{${labels}}`;
}

/** Ein Abruf von `/metrics` zu einem Zeitpunkt. */
export interface MetricsSnapshot {
  at: number;
  samples: readonly MetricSample[];
}

function matching(snapshot: MetricsSnapshot, name: string, filter?: LabelFilter): MetricSample[] {
  return snapshot.samples.filter((sample) => sample.name === name && (filter === undefined || filter(sample.labels)));
}

/** Wert einer Serie (erste passende) oder `null`. */
export function gaugeValue(snapshot: MetricsSnapshot, name: string, filter?: LabelFilter): number | null {
  return matching(snapshot, name, filter)[0]?.value ?? null;
}

/**
 * Zuwachs eines Zählers zwischen zwei Abrufen, je Serie aufsummiert (`group` liefert zusätzlich die Aufteilung,
 * z. B. nach Regel). Sinkt eine Serie (Neustart), zählt ihr aktueller Wert als Zuwachs.
 */
export function counterDelta(
  current: MetricsSnapshot,
  previous: MetricsSnapshot | undefined,
  name: string,
  filter?: LabelFilter,
  group?: (labels: Readonly<Record<string, string>>) => string,
): { total: number; groups: Map<string, number> } {
  const before = new Map<string, number>();
  if (previous !== undefined) {
    for (const sample of matching(previous, name, filter)) before.set(seriesKey(sample), sample.value);
  }
  const groups = new Map<string, number>();
  let total = 0;
  for (const sample of matching(current, name, filter)) {
    const old = before.get(seriesKey(sample)) ?? 0;
    const delta = sample.value >= old ? sample.value - old : sample.value;
    if (!Number.isFinite(delta) || delta <= 0) continue;
    total += delta;
    if (group !== undefined) {
      const key = group(sample.labels);
      groups.set(key, (groups.get(key) ?? 0) + delta);
    }
  }
  return { total, groups };
}

/** „a 12, b 3“ – die größten Anteile zuerst. */
function describeGroups(groups: Map<string, number>, limit = 3): string {
  return [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => `${key} ${Math.round(value)}`)
    .join(", ");
}

// ── Webhook ──────────────────────────────────────────────────────────────────────────────────────────

/** Nutzlast für Discord (`content`) und Slack (`text`), wie `scripts/ops/lib/alert.ts`. */
export interface AlertPayload {
  content: string;
  text: string;
}

/** Discord erlaubt 2.000 Zeichen; Massen-Erwähnungen (@everyone/@here/@channel) werden entschärft. */
export function alertPayload(message: string, host: string): AlertPayload {
  const safe = message
    .replace(/@(everyone|here|channel)/gi, "(at)$1")
    .replace(/\s+/g, " ")
    .trim();
  const text = `quizmaster (${host}): ${safe}`.slice(0, 1_900);
  return { content: text, text };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Fehlerart ohne URL (die Webhook-URL enthält das Token). */
function describeFetchError(error: unknown): string {
  const code = (error as { cause?: { code?: unknown } }).cause?.code;
  if (typeof code === "string") return code;
  if (error instanceof Error) return error.name;
  return "Fehler";
}

// ── Regeln ───────────────────────────────────────────────────────────────────────────────────────────

export const WATCHDOG_RULES = [
  "web_health",
  "realtime_health",
  "event_loop",
  "error_rate",
  "limit_spike",
  "change_stream",
  "mongo",
  "restart_loop",
  "metrics",
] as const;
export type WatchdogRule = (typeof WATCHDOG_RULES)[number];

/** Ergebnis einer Regel in einer Prüfung: gestört, in Ordnung oder (mangels Daten) unbekannt. */
type Verdict = { kind: "bad"; detail: string } | { kind: "good"; detail?: string } | { kind: "unknown" };

interface RuleState {
  status: "ok" | "pending" | "firing";
  badSince: number;
  /** Wurde der aktuelle Alarm gemeldet (sonst gibt es auch keine Entwarnung)? */
  notified: boolean;
  /** Letzter gemeldeter Alarm dieser Regel (Cooldown, Erinnerung). */
  lastAlertAt: number | null;
  /** Zustellung offen (Webhook war nicht erreichbar). */
  retryAt: number | null;
  retryMessage: string | null;
}

interface RuleSpec {
  /** Haltezeit, bevor gemeldet wird. */
  forMs: number;
  title: string;
  /** Handlungshinweis (Runbook docs/12, README). */
  hint: string;
}

/** Ergebnis einer Health-Anfrage. */
export interface HealthResult {
  healthy: boolean;
  /** HTTP-Status oder Fehlerart. */
  detail: string;
}

export interface WatchdogOptions {
  env: Pick<WatchdogEnv, "WEB_HEALTH_URL" | "REALTIME_HEALTH_URL" | "REALTIME_METRICS_URL" | "METRICS_TOKEN"> &
    Partial<Pick<WatchdogEnv, "ALERT_WEBHOOK_URL">>;
  logger: Logger;
  fetch?: FetchLike;
  now?: () => number;
  host?: string;
  thresholds?: Partial<WatchdogThresholds>;
  intervalMs?: number;
  requestTimeoutMs?: number;
}

export interface WatchdogReport {
  at: number;
  web: HealthResult;
  realtime: HealthResult;
  metrics: "ok" | "unavailable" | "skipped";
  /** Regeln, die gerade melden (firing). */
  firing: WatchdogRule[];
}

export interface Watchdog {
  /** Eine Prüfung (Health, Metriken, Regeln, Benachrichtigungen). Wirft nie. */
  tick(): Promise<WatchdogReport>;
  /** Startet die Prüfungen (sofort, dann alle `intervalMs`). */
  start(): void;
  /** Hält an und bricht laufende Anfragen ab; wartet höchstens `WATCHDOG_STOP_GRACE_MS`. */
  stop(): Promise<void>;
  /** Zustand je Regel (Tests, Diagnose). */
  status(rule: WatchdogRule): RuleState["status"];
}

export function createWatchdog(options: WatchdogOptions): Watchdog {
  const { env, logger } = options;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const host = options.host ?? hostname();
  const limits: WatchdogThresholds = { ...WATCHDOG_THRESHOLDS, ...options.thresholds };
  const intervalMs = options.intervalMs ?? WATCHDOG_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? WATCHDOG_REQUEST_TIMEOUT_MS;
  const webhookUrl = env.ALERT_WEBHOOK_URL;

  const specs: Record<WatchdogRule, RuleSpec> = {
    web_health: {
      forMs: limits.healthDownForMs,
      title: "Web /api/health gestört",
      hint: "pm2 status; pm2 logs quizmaster-web --lines 100; pnpm deploy:status",
    },
    realtime_health: {
      forMs: limits.healthDownForMs,
      title: "Realtime /healthz gestört",
      hint: "pm2 logs quizmaster-realtime --lines 100; Fragenkatalog/Mongo prüfen; pnpm deploy:status",
    },
    event_loop: {
      forMs: limits.eventLoopForMs,
      title: `Event-Loop p99 > ${Math.round(limits.eventLoopP99Seconds * 1_000)} ms`,
      hint: "Runbook: maxActiveLobbies senken bzw. Lobby-Erstellung pausieren (pnpm admin:config), dann Neustart",
    },
    error_rate: {
      forMs: 0,
      title: `Fehlerrate > ${(limits.errorRate * 100).toLocaleString("de-DE")} %`,
      hint: "pm2 logs quizmaster-realtime (requestId der INTERNAL-Fehler)",
    },
    limit_spike: {
      forMs: 0,
      title: "Limit-Treffer-Spitze (Angriff?)",
      hint: "docs/06 Notfall-Runbook: Cloudflare-Regeln, turnstileOnJoin, pnpm admin:ban",
    },
    change_stream: {
      forMs: 0,
      title: "Change Streams wiederholt neu gestartet",
      hint: "Cluster-Status und Rechte prüfen; pm2 logs quizmaster-realtime",
    },
    mongo: {
      forMs: 0,
      title: "MongoDB-Fehler",
      hint: "Cluster/Netzwerk prüfen (laufende Spiele laufen im Speicher weiter); pnpm env:check prod --connect",
    },
    restart_loop: {
      forMs: 0,
      title: "Realtime startet wiederholt neu",
      hint: "pm2 logs quizmaster-realtime --lines 200; pnpm deploy:status (ggf. pnpm deploy:rollback)",
    },
    metrics: {
      forMs: limits.metricsDownForMs,
      title: "/metrics nicht lesbar",
      hint: "METRICS_TOKEN in .env.prod prüfen, dann pnpm deploy:restart",
    },
  };

  const states = new Map<WatchdogRule, RuleState>(
    WATCHDOG_RULES.map((rule) => [
      rule,
      {
        status: "ok",
        badSince: 0,
        notified: false,
        lastAlertAt: null,
        retryAt: null,
        retryMessage: null,
      },
    ]),
  );
  const stateOf = (rule: WatchdogRule): RuleState => {
    const state = states.get(rule);
    if (state === undefined) throw new Error(`Unbekannte Regel ${rule}`);
    return state;
  };

  /** Abrufe von /metrics, älteste zuerst (für Zählerfenster); geleert bei einem Neustart von Realtime. */
  let history: MetricsSnapshot[] = [];
  const maxWindowMs = Math.max(
    limits.errorRateWindowMs,
    limits.limitSpikeWindowMs,
    limits.changeStreamWindowMs,
    limits.mongoWindowMs,
  );
  let lastStartTime: number | null = null;
  const restarts: number[] = [];

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> | null = null;
  let stopped = false;
  const inflight = new AbortController();

  const timeoutSignal = (ms: number) => AbortSignal.any([inflight.signal, AbortSignal.timeout(ms)]);

  const send = async (rule: WatchdogRule, message: string): Promise<boolean> => {
    logger.warn({ rule, alert: message }, message.startsWith("Entwarnung") ? "ENTWARNUNG" : "ALARM");
    if (webhookUrl === undefined) return true;
    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alertPayload(message, host)),
        redirect: "error",
        signal: timeoutSignal(WEBHOOK_TIMEOUT_MS),
      });
      // Antwortkörper verwerfen (Verbindung freigeben); Inhalt ist uninteressant.
      await response.body?.cancel();
      if (!response.ok) {
        logger.error({ status: response.status }, "Webhook lehnt den Alarm ab");
        return false;
      }
      return true;
    } catch (error) {
      logger.error({ reason: describeFetchError(error) }, "Webhook nicht erreichbar");
      return false;
    }
  };

  const notify = async (rule: WatchdogRule, state: RuleState, message: string, at: number) => {
    const delivered = await send(rule, message);
    state.retryAt = delivered ? null : at + limits.retryNotifyMs;
    state.retryMessage = delivered ? null : message;
  };

  const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

  /** Wendet ein Prüfergebnis auf eine Regel an (Entprellung, Cooldown, Erinnerung, Entwarnung). */
  const apply = async (rule: WatchdogRule, verdict: Verdict, at: number) => {
    const state = stateOf(rule);
    const spec = specs[rule];
    if (state.retryAt !== null && state.retryMessage !== null && at >= state.retryAt) {
      await notify(rule, state, state.retryMessage, at);
    }
    if (verdict.kind === "unknown") return;
    if (verdict.kind === "bad") {
      if (state.status === "ok") {
        state.status = "pending";
        state.badSince = at;
        logger.info({ rule, detail: verdict.detail }, "Störung erkannt – Alarm nach Haltezeit");
      }
      if (state.status === "pending" && at - state.badSince >= spec.forMs) {
        state.status = "firing";
        const coolingDown = state.lastAlertAt !== null && at - state.lastAlertAt < limits.cooldownMs;
        if (coolingDown) {
          state.notified = false;
          logger.warn(
            { rule, detail: verdict.detail },
            "Alarm unterdrückt (Cooldown) – erneute Störung kurz nach der letzten",
          );
          return;
        }
        state.notified = true;
        state.lastAlertAt = at;
        const since = spec.forMs > 0 ? ` seit ${minutes(at - state.badSince)} min` : "";
        await notify(rule, state, `ALARM ${spec.title}${since}: ${verdict.detail} – ${spec.hint}`, at);
        return;
      }
      if (state.status === "firing" && state.notified && state.lastAlertAt !== null) {
        if (at - state.lastAlertAt >= limits.repeatMs) {
          state.lastAlertAt = at;
          await notify(
            rule,
            state,
            `ALARM weiterhin: ${spec.title} seit ${minutes(at - state.badSince)} min: ${verdict.detail} – ${spec.hint}`,
            at,
          );
        }
      }
      return;
    }
    // In Ordnung
    if (state.status === "firing" && state.notified) {
      const resolved = `Entwarnung: ${spec.title} – wieder in Ordnung nach etwa ${minutes(at - state.badSince)} min`;
      await notify(rule, state, verdict.detail === undefined ? resolved : `${resolved} (${verdict.detail})`, at);
    } else if (state.status !== "ok") {
      logger.info({ rule }, "Störung vorbei – kein Alarm nötig");
    }
    state.status = "ok";
    state.notified = false;
  };

  const probeHealth = async (url: string): Promise<HealthResult> => {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: timeoutSignal(requestTimeoutMs),
      });
      const text = await response.text();
      if (response.status === 429) return { healthy: true, detail: "HTTP 429 (lebt, Rate-Limit)" };
      if (response.status !== 200) return { healthy: false, detail: `HTTP ${response.status}` };
      if (/"ok"\s*:\s*false/.test(text)) return { healthy: false, detail: "HTTP 200 mit ok: false" };
      return { healthy: true, detail: "HTTP 200" };
    } catch (error) {
      return { healthy: false, detail: `keine Antwort (${describeFetchError(error)})` };
    }
  };

  type MetricsFetch =
    | { kind: "ok"; snapshot: MetricsSnapshot }
    | { kind: "skipped" }
    | { kind: "failed"; detail: string };

  const fetchMetrics = async (at: number): Promise<MetricsFetch> => {
    try {
      const response = await fetchImpl(env.REALTIME_METRICS_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${env.METRICS_TOKEN}`, accept: "text/plain" },
        redirect: "error",
        signal: timeoutSignal(requestTimeoutMs),
      });
      const text = await response.text();
      if (response.status === 429) return { kind: "skipped" };
      if (response.status !== 200) {
        const hint = response.status === 401 ? " – METRICS_TOKEN passt nicht" : "";
        return { kind: "failed", detail: `HTTP ${response.status}${hint}` };
      }
      const samples = parsePrometheusText(text);
      if (!samples.some((sample) => sample.name.startsWith("qm_"))) {
        return { kind: "failed", detail: "Antwort ohne qm_-Metriken" };
      }
      return { kind: "ok", snapshot: { at, samples } };
    } catch (error) {
      return { kind: "failed", detail: `keine Antwort (${describeFetchError(error)})` };
    }
  };

  /** Ältester Abruf, der höchstens `windowMs` zurückliegt (Fensteranfang). */
  const baseline = (at: number, windowMs: number): MetricsSnapshot | undefined =>
    history.find((snapshot) => snapshot.at >= at - windowMs && snapshot.at < at);

  const evaluateMetrics = (current: MetricsSnapshot, previous: MetricsSnapshot | undefined) => {
    const at = current.at;
    const verdicts = new Map<WatchdogRule, Verdict>();

    // Neustarts von Realtime (Startzeit wechselt) – Zählerhistorie gilt dann nicht mehr.
    const startTime = gaugeValue(current, "qm_process_start_time_seconds");
    if (startTime !== null && lastStartTime !== null && startTime !== lastStartTime) {
      restarts.push(at);
      history = [];
      logger.info({ startTime }, "Realtime wurde neu gestartet");
    }
    if (startTime !== null) lastStartTime = startTime;
    while (restarts.length > 0 && (restarts[0] ?? at) < at - limits.restartWindowMs) restarts.shift();
    verdicts.set(
      "restart_loop",
      restarts.length >= limits.restarts
        ? { kind: "bad", detail: `${restarts.length} Neustarts in ${minutes(limits.restartWindowMs)} min` }
        : { kind: "good" },
    );

    // Event-Loop: alle Fenster seit dem letzten Abruf über der Grenze? (Histogramm; sonst Gauge als Ersatz)
    const bucketFilter: LabelFilter = (labels) => Number(labels.le) === limits.eventLoopP99Seconds;
    const windows = counterDelta(current, previous, "qm_event_loop_p99_seconds_count").total;
    const fastWindows = counterDelta(current, previous, "qm_event_loop_p99_seconds_bucket", bucketFilter).total;
    const lastP99 = gaugeValue(current, "qm_event_loop_delay_seconds", (labels) => labels.quantile === "0.99");
    const p99Text = lastP99 === null ? "" : ` (zuletzt ${Math.round(lastP99 * 1_000)} ms)`;
    const hasBucket = matching(current, "qm_event_loop_p99_seconds_bucket", bucketFilter).length > 0;
    if (previous !== undefined && hasBucket && windows > 0) {
      verdicts.set(
        "event_loop",
        fastWindows === 0
          ? { kind: "bad", detail: `alle ${Math.round(windows)} Messfenster über der Grenze${p99Text}` }
          : { kind: "good" },
      );
    } else if (!hasBucket && lastP99 !== null) {
      verdicts.set(
        "event_loop",
        lastP99 > limits.eventLoopP99Seconds ? { kind: "bad", detail: `p99${p99Text}` } : { kind: "good" },
      );
    } else {
      verdicts.set("event_loop", { kind: "unknown" });
    }

    // Fehlerrate (INTERNAL-Acks) im Fenster
    const errorBase = baseline(at, limits.errorRateWindowMs);
    if (errorBase === undefined) {
      verdicts.set("error_rate", { kind: "unknown" });
    } else {
      const all = counterDelta(current, errorBase, "qm_socket_events_total").total;
      const internal = counterDelta(
        current,
        errorBase,
        "qm_socket_events_total",
        (labels) => labels.outcome === "INTERNAL",
        (labels) => labels.event ?? "?",
      );
      const rate = all > 0 ? internal.total / all : 0;
      verdicts.set(
        "error_rate",
        all >= limits.errorRateMinEvents && rate > limits.errorRate
          ? {
              kind: "bad",
              detail: `${(rate * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} % (${Math.round(internal.total)} von ${Math.round(all)} Events INTERNAL in ${minutes(limits.errorRateWindowMs)} min; ${describeGroups(internal.groups)})`,
            }
          : { kind: "good" },
      );
    }

    // Limit-Treffer-Spitze
    const limitBase = baseline(at, limits.limitSpikeWindowMs);
    if (limitBase === undefined) {
      verdicts.set("limit_spike", { kind: "unknown" });
    } else {
      const hits = counterDelta(
        current,
        limitBase,
        "qm_rate_limit_hits_total",
        undefined,
        (labels) => labels.rule ?? "?",
      );
      verdicts.set(
        "limit_spike",
        hits.total >= limits.limitSpikeHits
          ? {
              kind: "bad",
              detail: `${Math.round(hits.total)} Treffer in ${minutes(limits.limitSpikeWindowMs)} min (${describeGroups(hits.groups)})`,
            }
          : { kind: "good" },
      );
    }

    // Change Streams
    const streamBase = baseline(at, limits.changeStreamWindowMs);
    if (streamBase === undefined) {
      verdicts.set("change_stream", { kind: "unknown" });
    } else {
      const restartsDelta = counterDelta(
        current,
        streamBase,
        "qm_change_stream_restarts_total",
        undefined,
        (labels) => `${labels.stream ?? "?"}: ${labels.reason ?? "?"}`,
      );
      verdicts.set(
        "change_stream",
        restartsDelta.total >= limits.changeStreamRestarts
          ? {
              kind: "bad",
              detail: `${Math.round(restartsDelta.total)}× in ${minutes(limits.changeStreamWindowMs)} min (${describeGroups(restartsDelta.groups)})`,
            }
          : { kind: "good" },
      );
    }

    // Mongo-Fehler
    const mongoBase = baseline(at, limits.mongoWindowMs);
    if (mongoBase === undefined) {
      verdicts.set("mongo", { kind: "unknown" });
    } else {
      const errors = counterDelta(
        current,
        mongoBase,
        "qm_mongo_errors_total",
        undefined,
        (labels) => labels.operation ?? "?",
      );
      let connection = 0;
      for (const [operation, count] of errors.groups) {
        if (MONGO_CONNECTION_OPERATIONS.has(operation)) connection += count;
      }
      const other = errors.total - connection;
      verdicts.set(
        "mongo",
        connection >= limits.mongoConnectionErrors || other >= limits.mongoOtherErrors
          ? {
              kind: "bad",
              detail: `${Math.round(errors.total)} Fehler in ${minutes(limits.mongoWindowMs)} min, davon ${Math.round(connection)} Verbindungsfehler (${describeGroups(errors.groups)})`,
            }
          : { kind: "good" },
      );
    }
    return verdicts;
  };

  const runTick = async (): Promise<WatchdogReport> => {
    const at = now();
    const [web, realtime] = await Promise.all([probeHealth(env.WEB_HEALTH_URL), probeHealth(env.REALTIME_HEALTH_URL)]);
    // Beim Beenden abgebrochene Anfragen sind keine Störung.
    if (stopped) return { at, web, realtime, metrics: "skipped", firing: [] };
    await apply("web_health", web.healthy ? { kind: "good" } : { kind: "bad", detail: web.detail }, at);
    await apply("realtime_health", realtime.healthy ? { kind: "good" } : { kind: "bad", detail: realtime.detail }, at);

    let metricsStatus: WatchdogReport["metrics"] = "skipped";
    const fetched = await fetchMetrics(at);
    if (fetched.kind === "ok") {
      metricsStatus = "ok";
      await apply("metrics", { kind: "good" }, at);
      const previous = history.at(-1);
      const verdicts = evaluateMetrics(fetched.snapshot, previous);
      history.push(fetched.snapshot);
      history = history.filter((snapshot) => snapshot.at >= at - maxWindowMs - intervalMs);
      for (const [rule, verdict] of verdicts) await apply(rule, verdict, at);
    } else if (fetched.kind === "failed") {
      metricsStatus = "unavailable";
      // Ist Realtime selbst gestört, meldet das die Health-Regel – hier nicht doppelt.
      await apply("metrics", realtime.healthy ? { kind: "bad", detail: fetched.detail } : { kind: "unknown" }, at);
    }
    const firing = WATCHDOG_RULES.filter((rule) => stateOf(rule).status === "firing");
    logger.debug({ web: web.detail, realtime: realtime.detail, metrics: metricsStatus, firing }, "Prüfung");
    return { at, web, realtime, metrics: metricsStatus, firing };
  };

  const tick = (): Promise<WatchdogReport> => {
    const task = runTick().catch((error: unknown) => {
      logger.error({ err: error }, "Prüfung fehlgeschlagen");
      const at = now();
      const unknown: HealthResult = { healthy: false, detail: "Prüfung fehlgeschlagen" };
      return { at, web: unknown, realtime: unknown, metrics: "skipped" as const, firing: [] };
    });
    running = task;
    return task;
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().then(schedule);
    }, intervalMs);
  };

  return {
    tick,
    start() {
      if (timer !== undefined || stopped) return;
      logger.info(
        {
          intervalMs,
          webhook: webhookUrl !== undefined,
          web: env.WEB_HEALTH_URL,
          realtime: env.REALTIME_HEALTH_URL,
        },
        webhookUrl === undefined
          ? "Watchdog gestartet – ohne ALERT_WEBHOOK_URL: Alarme nur im Log"
          : "Watchdog gestartet",
      );
      void tick().then(schedule);
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      inflight.abort();
      if (running !== null) {
        let grace: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          running,
          new Promise<void>((resolve) => {
            grace = setTimeout(resolve, WATCHDOG_STOP_GRACE_MS);
          }),
        ]);
        clearTimeout(grace);
      }
    },
    status: (rule) => stateOf(rule).status,
  };
}

// ── Prozess ──────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseWatchdogEnv(process.env);
  if (!parsed.ok) {
    console.error(`watchdog – Env ungültig:\n${parsed.problems.map((problem) => `  - ${problem}`).join("\n")}`);
    process.exit(1);
  }
  const destination = pino.destination({ dest: 1, sync: false });
  const logger = createLogger({
    level: parsed.env.LOG_LEVEL,
    destination,
    base: { app: "quizmaster-watchdog", origin: parsed.env.APP_ORIGIN },
  });
  const watchdog = createWatchdog({ env: parsed.env, logger });
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Watchdog beendet");
    void watchdog.stop().finally(() => {
      destination.flushSync();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  watchdog.start();
}

/** true, wenn diese Datei als Programm gestartet wurde (dist/watchdog.mjs), nicht beim Import in Tests. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch (error) {
    console.error("watchdog – Einstiegspunkt nicht bestimmbar", error instanceof Error ? error.message : error);
    return false;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error("watchdog – unerwarteter Fehler beim Start", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
