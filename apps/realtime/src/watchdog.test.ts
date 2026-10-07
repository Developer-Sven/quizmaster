/**
 * Watchdog (docs/12 §Alarme) gegen Fake-Endpunkte: ein echter HTTP-Server auf 127.0.0.1 spielt Web
 * (`/api/health`), Realtime (`/healthz`, `/metrics` mit Bearer-Token) und den Webhook (`/hook`). Die Uhr ist
 * simuliert – Haltezeiten (2 min, 5 min) und Fenster laufen ohne Warten ab.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  alertPayload,
  counterDelta,
  createWatchdog,
  gaugeValue,
  parsePrometheusText,
  parseWatchdogEnv,
  WATCHDOG_THRESHOLDS,
  type Watchdog,
} from "./watchdog.ts";

const TOKEN = "t".repeat(40);
const HOOK_SECRET_PATH = "/hook/geheimes-token-123";

interface FakeState {
  web: number;
  webBody: string;
  realtime: number;
  metricsStatus: number;
  /** Zählerstände; `metricsText()` baut daraus den Prometheus-Text. */
  counters: {
    events: Record<string, number>;
    limitHits: Record<string, number>;
    streamRestarts: number;
    mongo: Record<string, number>;
    loopWindows: number;
    /** Fenster mit p99 ≤ 0,2 s. */
    loopFast: number;
    /** Schutzautomatik: zurückgezogene bzw. vom Budget zurückgehaltene Fragen je Grund. */
    autoRetired: Record<string, number>;
    retireSuppressed: Record<string, number>;
  };
  startTime: number;
  hookStatus: number;
  hang: boolean;
}

const fresh = (): FakeState => ({
  web: 200,
  webBody: '{"ok":true}',
  realtime: 200,
  metricsStatus: 200,
  counters: {
    events: { ok: 1_000, INTERNAL: 0 },
    limitHits: {},
    streamRestarts: 0,
    mongo: {},
    loopWindows: 10,
    loopFast: 10,
    autoRetired: {},
    retireSuppressed: {},
  },
  startTime: 1_759_300_000,
  hookStatus: 204,
  hang: false,
});

let state = fresh();
const hooks: Array<{ content: string; text: string }> = [];
let metricsAuth: string | undefined;
let server: Server;
let base = "";

function metricsText(): string {
  const c = state.counters;
  const lines = [
    "# HELP qm_socket_events_total Client-Events",
    "# TYPE qm_socket_events_total counter",
    ...Object.entries(c.events).map(
      ([outcome, value]) => `qm_socket_events_total{event="game:answer",outcome="${outcome}"} ${value}`,
    ),
    ...Object.entries(c.limitHits).map(([rule, value]) => `qm_rate_limit_hits_total{rule="${rule}"} ${value}`),
    `qm_change_stream_restarts_total{stream="questions",reason="resume_failed"} ${c.streamRestarts}`,
    ...Object.entries(c.mongo).map(([operation, value]) => `qm_mongo_errors_total{operation="${operation}"} ${value}`),
    `qm_event_loop_delay_seconds{quantile="0.99"} ${c.loopFast === c.loopWindows ? 0.012 : 0.43}`,
    `qm_event_loop_p99_seconds_bucket{le="0.1"} ${c.loopFast}`,
    `qm_event_loop_p99_seconds_bucket{le="0.2"} ${c.loopFast}`,
    `qm_event_loop_p99_seconds_bucket{le="+Inf"} ${c.loopWindows}`,
    `qm_event_loop_p99_seconds_count ${c.loopWindows}`,
    ...Object.entries(c.autoRetired).map(
      ([reason, value]) => `qm_questions_auto_retired_total{reason="${reason}"} ${value}`,
    ),
    ...Object.entries(c.retireSuppressed).map(
      ([reason, value]) => `qm_questions_auto_retire_suppressed_total{reason="${reason}"} ${value}`,
    ),
    `qm_process_start_time_seconds ${state.startTime}`,
    "qm_sockets 3",
  ];
  return `${lines.join("\n")}\n`;
}

function respond(res: ServerResponse, status: number, body: string, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function handle(req: IncomingMessage, res: ServerResponse) {
  if (state.hang) return; // nie antworten (Abbruch beim Beenden)
  if (req.url === "/api/health") return respond(res, state.web, state.webBody);
  if (req.url === "/healthz") return respond(res, state.realtime, `{"ok":${state.realtime === 200}}`);
  if (req.url === "/metrics") {
    metricsAuth = req.headers.authorization;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return respond(res, 401, '{"error":{}}');
    if (state.metricsStatus !== 200) return respond(res, state.metricsStatus, "");
    return respond(res, 200, metricsText(), "text/plain; version=0.0.4");
  }
  if (req.url === HOOK_SECRET_PATH && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      hooks.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as { content: string; text: string });
      respond(res, state.hookStatus, "");
    });
    return;
  }
  respond(res, 404, "");
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let clock = 0;
let logLines: string[] = [];
let watchdog: Watchdog | undefined;

function makeWatchdog(options: { webhook?: boolean; token?: string } = {}): Watchdog {
  logLines = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => logLines.push(line) });
  watchdog = createWatchdog({
    env: {
      WEB_HEALTH_URL: `${base}/api/health`,
      REALTIME_HEALTH_URL: `${base}/healthz`,
      REALTIME_METRICS_URL: `${base}/metrics`,
      METRICS_TOKEN: options.token ?? TOKEN,
      ...(options.webhook === false ? {} : { ALERT_WEBHOOK_URL: `${base}${HOOK_SECRET_PATH}` }),
    },
    logger,
    now: () => clock,
    host: "test-host",
    requestTimeoutMs: 2_000,
  });
  return watchdog;
}

/** Simuliert Prüfungen alle 30 s über `durationMs`; `each` ändert vorher den Fake-Zustand. */
async function run(dog: Watchdog, durationMs: number, each?: () => void) {
  const end = clock + durationMs;
  while (clock < end) {
    clock += 30_000;
    each?.();
    await dog.tick();
  }
}

afterEach(async () => {
  await watchdog?.stop();
  watchdog = undefined;
  state = fresh();
  hooks.length = 0;
  clock = 0;
});

describe("Prometheus-Text", () => {
  it("liest Zähler, Labels mit Escapes, Histogramme und Sonderwerte", () => {
    const samples = parsePrometheusText(
      [
        "# HELP x y",
        'qm_a_total{event="lobby:join",outcome="ok"} 12',
        'qm_b{label="mit \\"Zitat\\" und \\\\ und\\nZeile"} 1.5e3',
        'qm_h_bucket{le="+Inf"} 7',
        "qm_nan NaN",
        "qm_plain 3 1700000000000",
        "kaputt{",
      ].join("\n"),
    );
    expect(samples).toHaveLength(5);
    expect(samples[0]).toEqual({ name: "qm_a_total", labels: { event: "lobby:join", outcome: "ok" }, value: 12 });
    expect(samples[1]?.labels.label).toBe('mit "Zitat" und \\ und\nZeile');
    expect(samples[1]?.value).toBe(1_500);
    expect(samples[2]?.labels.le).toBe("+Inf");
    expect(Number.isNaN(samples[3]?.value)).toBe(true);
    expect(samples[4]?.value).toBe(3);
  });

  it("berechnet Zuwächse je Serie und erkennt Zähler-Neustarts", () => {
    const at = (text: string, time: number) => ({ at: time, samples: parsePrometheusText(text) });
    const before = at('c{r="a"} 10\nc{r="b"} 5', 0);
    const after = at('c{r="a"} 25\nc{r="b"} 2\nc{r="c"} 4', 30_000);
    const delta = counterDelta(after, before, "c", undefined, (labels) => labels.r ?? "?");
    // a: +15, b: Neustart → 2, c: neu → 4
    expect(delta.total).toBe(21);
    expect(Object.fromEntries(delta.groups)).toEqual({ a: 15, b: 2, c: 4 });
    expect(gaugeValue(after, "c", (labels) => labels.r === "c")).toBe(4);
    expect(gaugeValue(after, "fehlt")).toBeNull();
  });
});

describe("Webhook-Nutzlast und Env", () => {
  it("ist Discord- und Slack-kompatibel und entschärft Massen-Erwähnungen", () => {
    const payload = alertPayload("Hilfe @everyone und @here,\n  @Channel   bitte", "host-1");
    expect(payload.content).toBe(payload.text);
    expect(payload.text).toBe("quizmaster (host-1): Hilfe (at)everyone und (at)here, (at)Channel bitte");
    expect(alertPayload("x".repeat(5_000), "h").text.length).toBeLessThanOrEqual(1_900);
  });

  it("prüft die Env ohne Werte in den Meldungen", () => {
    const valid = {
      WEB_HEALTH_URL: "http://127.0.0.1:7400/api/health",
      REALTIME_HEALTH_URL: "http://127.0.0.1:7401/healthz",
      REALTIME_METRICS_URL: "http://127.0.0.1:7401/metrics",
      METRICS_TOKEN: TOKEN,
    };
    const ok = parseWatchdogEnv({ ...valid, ALERT_WEBHOOK_URL: "", LOG_LEVEL: "warn" });
    expect(ok.ok && ok.env.ALERT_WEBHOOK_URL === undefined && ok.env.LOG_LEVEL === "warn").toBe(true);
    const insecure = parseWatchdogEnv({ ...valid, ALERT_WEBHOOK_URL: "http://hooks.example/geheim" });
    expect(insecure.ok).toBe(false);
    if (!insecure.ok) {
      expect(insecure.problems.join(" ")).toContain("ALERT_WEBHOOK_URL");
      expect(insecure.problems.join(" ")).not.toContain("geheim");
    }
    const short = parseWatchdogEnv({ ...valid, METRICS_TOKEN: "kurz" });
    expect(short.ok).toBe(false);
  });
});

describe("Alarme", () => {
  it("bleibt bei gesunden Diensten still und sendet den Token als Bearer", async () => {
    const dog = makeWatchdog();
    await run(dog, 10 * 60_000, () => {
      state.counters.events.ok = (state.counters.events.ok ?? 0) + 500;
      state.counters.loopWindows += 6;
      state.counters.loopFast += 6;
    });
    expect(hooks).toEqual([]);
    expect(metricsAuth).toBe(`Bearer ${TOKEN}`);
    const log = logLines.join("\n");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("geheimes-token");
  });

  it("meldet Health down erst nach 2 min, einmal, und gibt danach Entwarnung", async () => {
    const dog = makeWatchdog();
    state.realtime = 503;
    await run(dog, 90_000);
    expect(hooks).toEqual([]);
    expect(dog.status("realtime_health")).toBe("pending");
    await run(dog, 60_000);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.content).toContain("Realtime /healthz gestört seit 2 min");
    expect(hooks[0]?.content).toContain("HTTP 503");
    await run(dog, 5 * 60_000);
    expect(hooks).toHaveLength(1);
    state.realtime = 200;
    await run(dog, 30_000);
    expect(hooks).toHaveLength(2);
    expect(hooks[1]?.content).toContain("Entwarnung: Realtime /healthz gestört");
    expect(dog.status("realtime_health")).toBe("ok");
  });

  it("wertet 429 als lebendig und 200 mit ok: false als gestört", async () => {
    const dog = makeWatchdog();
    state.web = 429;
    await run(dog, 3 * 60_000);
    expect(dog.status("web_health")).toBe("ok");
    state.web = 200;
    state.webBody = '{"ok":false}';
    await run(dog, 3 * 60_000);
    expect(hooks.map((hook) => hook.content).join("\n")).toContain("ok: false");
  });

  it("meldet eine Fehlerrate über 1 % (ab 200 Events) mit den betroffenen Events", async () => {
    const dog = makeWatchdog();
    await run(dog, 60_000, () => {
      state.counters.events.ok = (state.counters.events.ok ?? 0) + 100;
    });
    expect(hooks).toEqual([]);
    await run(dog, 60_000, () => {
      state.counters.events.ok = (state.counters.events.ok ?? 0) + 150;
      state.counters.events.INTERNAL = (state.counters.events.INTERNAL ?? 0) + 5;
    });
    expect(hooks).toHaveLength(1);
    // Erste Auswertung nach den Fehlern: 5 von 255 Events (≈ 2 %) im Fenster.
    expect(hooks[0]?.content).toContain(
      "ALARM Fehlerrate > 1 %: 2 % (5 von 255 Events INTERNAL in 5 min; game:answer 5) – pm2 logs",
    );
    // Ohne neue Fehler fällt der Ausreißer nach 5 min aus dem Fenster → Entwarnung.
    await run(dog, 6 * 60_000, () => {
      state.counters.events.ok = (state.counters.events.ok ?? 0) + 150;
    });
    expect(hooks).toHaveLength(2);
    expect(hooks[1]?.content).toContain("Entwarnung: Fehlerrate");
  });

  it("ignoriert wenige Fehler bei wenig Verkehr", async () => {
    const dog = makeWatchdog();
    await run(dog, 3 * 60_000, () => {
      state.counters.events.ok = (state.counters.events.ok ?? 0) + 10;
      state.counters.events.INTERNAL = (state.counters.events.INTERNAL ?? 0) + 1;
    });
    expect(hooks).toEqual([]);
  });

  it("meldet Limit-Treffer-Spitzen mit den häufigsten Regeln", async () => {
    const dog = makeWatchdog();
    await run(dog, 30_000);
    await run(dog, 60_000, () => {
      state.counters.limitHits["lobby:join.failed.ip"] = (state.counters.limitHits["lobby:join.failed.ip"] ?? 0) + 90;
      state.counters.limitHits["socket.any-event"] = (state.counters.limitHits["socket.any-event"] ?? 0) + 20;
    });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.content).toContain("Limit-Treffer-Spitze (Angriff?): 220 Treffer in 5 min");
    expect(hooks[0]?.content).toContain("lobby:join.failed.ip 180, socket.any-event 40");
  });

  it("meldet Event-Loop-p99 > 200 ms erst nach 5 min durchgehender Überlast", async () => {
    const dog = makeWatchdog();
    await run(dog, 30_000);
    await run(dog, 4 * 60_000, () => {
      state.counters.loopWindows += 6;
    });
    expect(hooks).toEqual([]);
    expect(dog.status("event_loop")).toBe("pending");
    await run(dog, 90_000, () => {
      state.counters.loopWindows += 6;
    });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.content).toContain("Event-Loop p99 > 200 ms seit 5 min");
    expect(hooks[0]?.content).toContain("zuletzt 430 ms");
    // Ein schnelles Fenster dazwischen beendet die Störung.
    await run(dog, 30_000, () => {
      state.counters.loopWindows += 6;
      state.counters.loopFast += 1;
    });
    expect(hooks[1]?.content).toContain("Entwarnung: Event-Loop");
  });

  it("meldet anhaltende Change-Stream-Neustarts, Mongo-Verbindungsfehler und Neustart-Schleifen", async () => {
    const dog = makeWatchdog();
    await run(dog, 30_000);
    // Die Störung hält an: alle 30 s ein Neustart und ein Verbindungsfehler. Die Haltezeit beginnt, sobald die
    // Schwelle (3 im Fenster) erreicht ist.
    const failing = () => {
      state.counters.streamRestarts += 1;
      state.counters.mongo.heartbeat = (state.counters.mongo.heartbeat ?? 0) + 1;
    };
    await run(dog, WATCHDOG_THRESHOLDS.mongoForMs, failing);
    expect(hooks).toEqual([]);
    expect(dog.status("mongo")).toBe("pending");
    await run(dog, 90_000, failing);
    let texts = hooks.map((hook) => hook.content);
    expect(texts.some((text) => text.includes("ALARM MongoDB-Fehler seit 6 min: 10 Fehler in 5 min, davon 10"))).toBe(
      true,
    );
    expect(texts.some((text) => text.includes("Change Streams"))).toBe(false);
    await run(dog, WATCHDOG_THRESHOLDS.changeStreamForMs - WATCHDOG_THRESHOLDS.mongoForMs, failing);
    texts = hooks.map((hook) => hook.content);
    expect(texts.some((text) => text.includes("ALARM Change Streams wiederholt neu gestartet seit 16 min: 30×"))).toBe(
      true,
    );
    hooks.length = 0;
    await run(dog, 90_000, () => {
      state.startTime += 40;
    });
    expect(hooks.map((hook) => hook.content).join("\n")).toContain("Realtime startet wiederholt neu: 3 Neustarts");
  });

  it("ein kurzer Netzaussetzer (ein Fehlerschub, ADR-057) meldet weder Mongo noch Change Streams – auch keine Entwarnung", async () => {
    const dog = makeWatchdog();
    await run(dog, 60_000);
    // Wie im Betrieb: 2 Heartbeat-Fehler, 1 pool_cleared und je Stream ein Neustart binnen einer Minute.
    await run(dog, 60_000, () => {
      state.counters.streamRestarts += 4;
      state.counters.mongo.heartbeat = (state.counters.mongo.heartbeat ?? 0) + 1;
      state.counters.mongo.pool_cleared = 1;
    });
    expect(dog.status("mongo")).toBe("pending");
    expect(dog.status("change_stream")).toBe("pending");
    await run(dog, WATCHDOG_THRESHOLDS.changeStreamWindowMs + 60_000);
    expect(hooks).toEqual([]);
    expect(dog.status("mongo")).toBe("ok");
    expect(dog.status("change_stream")).toBe("ok");
    expect(logLines.join("\n")).toContain("Störung vorbei – kein Alarm nötig");
  });

  it("meldet viele Rückzüge der Schutzautomatik in 15 min und jedes Zurückhalten durch das Tagesbudget", async () => {
    const dog = makeWatchdog();
    const bump = (map: Record<string, number>, key: string, by: number) => {
      map[key] = (map[key] ?? 0) + by;
    };
    await run(dog, 30_000);
    // Vereinzelte Rückzüge sind normal …
    await run(dog, 60_000, () => bump(state.counters.autoRetired, "reports", 2));
    expect(hooks).toEqual([]);
    expect(dog.status("auto_retire")).toBe("ok");
    // … fünf in 15 min sind auffällig (Missbrauch der Meldungen?).
    await run(dog, 30_000, () => bump(state.counters.autoRetired, "rating", 1));
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.content).toContain("ALARM Schutzautomatik zieht ungewöhnlich viele Fragen zurück");
    expect(hooks[0]?.content).toContain("5 Fragen zurückgezogen (reports 4, rating 1)");
    expect(hooks[0]?.content).toContain("--restore-auto");
    // Ohne neue Rückzüge fällt die Spitze aus dem Fenster → Entwarnung.
    await run(dog, 16 * 60_000);
    expect(hooks[1]?.content).toContain("Entwarnung: Schutzautomatik");
    // Schon EIN vom Budget zurückgehaltener Rückzug ist ein Alarm (die Bremse greift nur unter Missbrauch).
    await run(dog, 30_000, () => bump(state.counters.retireSuppressed, "reports", 1));
    expect(hooks).toHaveLength(3);
    expect(hooks[2]?.content).toContain("1 vom Tagesbudget zurückgehalten");
  });

  it("meldet einen falschen METRICS_TOKEN nur, solange /healthz antwortet", async () => {
    const dog = makeWatchdog({ token: "f".repeat(40) });
    await run(dog, 6 * 60_000);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.content).toContain("/metrics nicht lesbar seit 5 min: HTTP 401 – METRICS_TOKEN passt nicht");
  });

  it("unterdrückt einen erneuten Alarm im Cooldown – ohne Entwarnung dafür", async () => {
    const dog = makeWatchdog();
    state.web = 500;
    await run(dog, 150_000);
    state.web = 200;
    await run(dog, 30_000);
    expect(hooks.map((hook) => hook.content.slice(0, 40))).toEqual([
      expect.stringContaining("ALARM Web"),
      expect.stringContaining("Entwarnung"),
    ]);
    state.web = 500;
    await run(dog, 150_000);
    state.web = 200;
    await run(dog, 30_000);
    expect(hooks).toHaveLength(2);
    expect(logLines.join("\n")).toContain("Cooldown");
    // Nach dem Cooldown wird wieder gemeldet.
    clock += WATCHDOG_THRESHOLDS.cooldownMs;
    state.web = 500;
    await run(dog, 150_000);
    expect(hooks).toHaveLength(3);
  });

  it("meldet eine im Cooldown unterdrückte Störung, sobald der Cooldown vorbei ist und sie anhält", async () => {
    const dog = makeWatchdog();
    state.web = 500;
    await run(dog, 150_000);
    state.web = 200;
    await run(dog, 60_000);
    expect(hooks).toHaveLength(2);
    // Zweiter Ausfall beginnt im Cooldown und dauert drei Stunden.
    state.web = 500;
    await run(dog, 150_000);
    expect(hooks).toHaveLength(2);
    expect(dog.status("web_health")).toBe("firing");
    await run(dog, 3 * 60 * 60_000);
    const texts = hooks.map((hook) => hook.content);
    // Genau ein nachgeholter Alarm nach dem Cooldown (danach höchstens stündliche Erinnerungen) …
    expect(texts[2]).toContain("ALARM Web /api/health gestört (anhaltend seit");
    expect(texts[2]).toContain("HTTP 500");
    expect(texts.slice(3).every((text) => text.includes("ALARM weiterhin"))).toBe(true);
    expect(texts.length).toBeGreaterThanOrEqual(4);
    expect(texts.length).toBeLessThanOrEqual(5);
    // … und eine Entwarnung, wenn die Störung endet.
    state.web = 200;
    await run(dog, 30_000);
    expect(hooks.at(-1)?.content).toContain("Entwarnung: Web /api/health gestört");
    expect(dog.status("web_health")).toBe("ok");
  });

  it("erinnert stündlich bei anhaltender Störung", async () => {
    const dog = makeWatchdog();
    state.realtime = 500;
    await run(dog, 150_000);
    await run(dog, WATCHDOG_THRESHOLDS.repeatMs);
    expect(hooks.map((hook) => hook.content.slice(0, 22))).toEqual([
      "quizmaster (test-host)",
      "quizmaster (test-host)",
    ]);
    expect(hooks[1]?.content).toContain("ALARM weiterhin");
  });

  it("loggt ohne Webhook nur und versucht gescheiterte Zustellungen später erneut", async () => {
    const silent = makeWatchdog({ webhook: false });
    state.realtime = 500;
    await run(silent, 150_000);
    expect(hooks).toEqual([]);
    expect(logLines.join("\n")).toContain("Realtime /healthz gestört");
    await silent.stop();

    state.hookStatus = 500;
    clock = 0;
    const failing = makeWatchdog();
    await run(failing, 150_000);
    expect(hooks).toHaveLength(1);
    expect(logLines.join("\n")).toContain("Webhook lehnt den Alarm ab");
    state.hookStatus = 204;
    await run(failing, WATCHDOG_THRESHOLDS.retryNotifyMs);
    expect(hooks).toHaveLength(2);
    expect(hooks[1]?.content).toBe(hooks[0]?.content);
  });

  it("beendet sich zügig, auch wenn ein Endpunkt hängt", async () => {
    const dog = makeWatchdog();
    state.hang = true;
    const pending = dog.tick();
    const started = Date.now();
    await dog.stop();
    expect(Date.now() - started).toBeLessThan(1_500);
    await pending;
    expect(hooks).toEqual([]);
  });
});
