// pnpm loadtest [--lobbies 125] [--players 8] [--duration 4m] [--ramp 60s] [--target <url>] … (--help)
//
// Lasttest (docs/07 §Lasttest, docs/11 §Last): echte socket.io-client-Verbindungen aus ≥ 2 Generator-Prozessen
// (worker.ts, mit `nice`), Spiele nach der Bot-Strategie der Engine, Tickets mit dem Test-Secret.
// Ohne --target: eigene Realtime-Instanz aus dem Prod-Build (apps/realtime/dist/index.mjs bzw. --realtime-entry),
// per `taskset` auf --cpus (Standard 0,1 = 2 vCPU laut docs/07), Test-DB `quizmaster_test` mit eigenem Präfix
// (Fixtures oder --catalog content), RATE_LIMIT_MODE=relaxed, GAME_TIMING=normal, eigene Zufalls-Secrets.
// Misst Verbindungsaufbau, Ack-Latenzen (p50/p95/p99), Zeit bis lobby:state, Broadcast-Latenz, Fehlerquote; zieht
// alle 5 s /metrics (Event-Loop, CPU, Speicher, Ack-Histogramm) und pingt die Datenbank. Ergebnis: Konsole,
// --json (Rohdaten) und --report (Markdown-Abschnitt für docs/perf-report.md).
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRepositories } from "@quizmaster/db";
import { createTestDatabase, type TestDatabase } from "@quizmaster/db/testing";
import { getTimings } from "@quizmaster/shared";
import { DEFAULT_CONTENT_DIR, FIXTURES_CONTENT_DIR } from "../content/lib/paths.ts";
import { prepareSeed, runSeed } from "../content/lib/seed-runner.ts";
import {
  findExecutable,
  isPortFree,
  type ManagedProcess,
  startProcess,
  stopProcess,
  tailFile,
  waitForHealth,
} from "../dev/lib/processes.ts";
import { baseChildEnv, createStackSecrets, redactSecrets } from "../dev/lib/stack-config.ts";
import { ConfigError, LOADTEST_USAGE, type LoadtestConfig, parseLoadtestArgs, planLobbies } from "./lib/config.ts";
import {
  bucketCounts,
  fractionAtMost,
  histogramQuantile,
  type PromSample,
  scrapeMetrics,
  seriesValue,
  sumOf,
} from "./lib/server-metrics.ts";
import { emptySamples, mergeStats, ms, observe, type Summary, summarize, type WorkerStats } from "./lib/stats.ts";
import { healthReasons, summarizeCounters } from "./lib/verdict.ts";
import type { FromWorker, ToWorker, WorkerConfig } from "./worker.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const MONITOR_INTERVAL_MS = 5_000;
const TEST_IP_HEADER = "x-qm-test-ip";

interface LocalServer {
  url: string;
  origin: string;
  /** Startzeit des Prozesses (Bezug der `--trace-gc`-Zeitstempel). */
  spawnedAt: number;
  ticketSecret: string;
  metricsToken: string;
  database: TestDatabase;
  proc: ManagedProcess;
  logDir: string;
  sensitive: string[];
}

interface TimelinePoint {
  t: number;
  sockets: number | null;
  lobbies: number | null;
  eventLoopP99Ms: number | null;
  cpuSeconds: number | null;
  rssMb: number | null;
  heapMb: number | null;
  overloaded: number | null;
  clients: number;
}

const log = (line: string) => console.info(`loadtest – ${line}`);

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function startLocalServer(config: LoadtestConfig, logDir: string): Promise<LocalServer> {
  const entry = config.realtimeEntry ?? join(REPO_ROOT, "apps/realtime/dist/index.mjs");
  if (!existsSync(entry)) {
    throw new ConfigError(`${entry} fehlt – erst bauen: pnpm --filter @quizmaster/realtime build`);
  }
  if (!(await isPortFree(config.port, "127.0.0.1"))) throw new ConfigError(`Port ${config.port} ist belegt (--port)`);
  const database = await createTestDatabase({ appName: "quizmaster-loadtest" });
  const sensitive = [database.uri];
  try {
    log(`Test-DB ${database.dbName} · Präfix ${database.prefix} · Quelle ${database.source}`);
    const contentDir = config.catalog === "content" ? DEFAULT_CONTENT_DIR : FIXTURES_CONTENT_DIR;
    const seedOptions = { env: "dev" as const, contentDir, prefix: database.prefix };
    const prepared = prepareSeed(seedOptions, database.dbName);
    const seeded = await runSeed(database.db, { ...seedOptions, dryRun: false, allowMassRetire: false }, prepared);
    log(`Katalog geseedet (${config.catalog}): ${seeded.questions} Fragen, ${seeded.categories} Kategorien`);

    const secrets = createStackSecrets();
    sensitive.push(...Object.values(secrets));
    const origin = config.origin ?? `http://127.0.0.1:${config.port - 1_000}`;
    const env: Record<string, string> = {
      ...baseChildEnv(process.env),
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      REALTIME_PORT: String(config.port),
      APP_ORIGIN: origin,
      MONGODB_URI: database.uri,
      MONGODB_DB: database.dbName,
      MONGODB_COLLECTION_PREFIX: database.prefix,
      REALTIME_TICKET_SECRET: secrets.realtimeTicket,
      IP_HASH_SECRET: secrets.ipHash,
      METRICS_TOKEN: secrets.metrics,
      // Jede simulierte Person hat eine eigene IP (wie hinter Cloudflare) – IP-Limits wirken realistisch.
      TRUSTED_IP_HEADER: TEST_IP_HEADER,
      GAME_TIMING: config.timing,
      QUESTION_POOL: "all",
      MAX_CONNECTIONS: "20000",
      DEV_BOTS_ENABLED: "false",
      RATE_LIMIT_MODE: "relaxed",
      LOG_LEVEL: "warn",
    };
    const taskset = findExecutable("taskset");
    const command = taskset ?? process.execPath;
    // --trace-gc: Heap nach jeder Garbage Collection im Log → belastbarer Speicher je Lobby (statt Sägezahn-Spitzen).
    const node = [process.execPath, "--trace-gc", entry];
    const args = taskset === null ? node.slice(1) : ["-c", config.cpus, ...node];
    const spawnedAt = Date.now();
    if (taskset === null) log("taskset fehlt – Realtime läuft ohne CPU-Bindung");
    const proc = startProcess({
      name: "realtime",
      command,
      args,
      cwd: dirname(dirname(entry)),
      env,
      logPath: join(logDir, "realtime.log"),
    });
    const url = `http://127.0.0.1:${config.port}`;
    const ready = await waitForHealth({ url: `${url}/healthz`, timeoutMs: 90_000, proc, aborted: () => false });
    if (ready !== "ready") {
      const tail = redactSecrets(tailFile(join(logDir, "realtime.log"), 30), sensitive);
      await stopProcess(proc, 10_000);
      throw new Error(`Realtime nicht bereit (${ready})\n${tail}`);
    }
    log(`Realtime bereit: ${url} (taskset -c ${config.cpus}, GAME_TIMING=${config.timing})`);
    return {
      url,
      origin,
      spawnedAt,
      ticketSecret: secrets.realtimeTicket,
      metricsToken: secrets.metrics,
      database,
      proc,
      logDir,
      sensitive,
    };
  } catch (error) {
    await database.cleanup();
    throw error;
  }
}

function spawnWorker(): ChildProcess {
  const worker = join(import.meta.dirname, "worker.ts");
  const nice = findExecutable("nice");
  const command = nice ?? process.execPath;
  const args = nice === null ? [worker] : ["-n", "10", process.execPath, worker];
  return spawn(command, args, { stdio: ["ignore", "inherit", "inherit", "ipc"], env: baseChildEnv(process.env) });
}

const mb = (bytes: number | null) => (bytes === null ? null : bytes / 1_048_576);

/** Strg+C / SIGTERM: Messung beenden, Generatoren und Server stoppen, Test-DB aufräumen. */
let aborted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (aborted) return;
    aborted = true;
    log(`${signal} – Lasttest wird beendet`);
  });
}

async function main(): Promise<number> {
  const parsed = parseLoadtestArgs(process.argv.slice(2));
  if (parsed === "help") {
    console.info(LOADTEST_USAGE);
    return 0;
  }
  const config = parsed;
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const absolute = (path: string) => (isAbsolute(path) ? path : resolve(cwd, path));
  const runId = stamp();
  const logDir = join(REPO_ROOT, "reports", "loadtest", runId);
  mkdirSync(logDir, { recursive: true });

  let server: LocalServer | null = null;
  let target: string;
  let origin: string;
  let ticketSecret: string;
  let metricsToken: string | null;
  if (config.target === null) {
    server = await startLocalServer(config, logDir);
    target = server.url;
    origin = server.origin;
    ticketSecret = server.ticketSecret;
    metricsToken = server.metricsToken;
  } else {
    const secret = process.env.LOADTEST_TICKET_SECRET;
    if (secret === undefined || secret.length < 32) throw new ConfigError("--target braucht LOADTEST_TICKET_SECRET");
    if (config.origin === null) throw new ConfigError("--target braucht --origin (eine Origin aus APP_ORIGIN)");
    target = config.target;
    origin = config.origin;
    ticketSecret = secret;
    metricsToken = process.env.LOADTEST_METRICS_TOKEN ?? null;
  }

  const scrape = async (): Promise<PromSample[] | null> => {
    if (metricsToken === null) return null;
    try {
      return await scrapeMetrics(target, metricsToken);
    } catch (error) {
      log(`/metrics nicht lesbar: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const workers: ChildProcess[] = [];
  const done = new Map<number, WorkerStats>();
  const progress = new Map<number, Extract<FromWorker, { type: "progress" }>>();
  const timeline: TimelinePoint[] = [];
  const dbPing = emptySamples();
  let shutdownMs: number | null = null;
  let shutdownResult: string | null = null;
  let baseline: PromSample[] | null = null;
  let rampEnd: PromSample[] | null = null;
  let final: PromSample[] | null = null;
  let peakSockets = 0;
  let peakLobbies = 0;
  let maxP99 = 0;
  let loadStartAt: number | null = null;
  try {
    baseline = await scrape();
    const startAt = Date.now() + 3_000;
    loadStartAt = startAt;
    const endAt = startAt + config.durationMs;
    const plan = planLobbies(config, startAt);
    // Lokal: guests-Dokumente wie nach POST /api/session – sonst liefen Spielabschluss ($inc, recentQuestionIds)
    // und das Laden gesehener Fragen ins Leere. Extern: zufällige guestIds (ohne Datenbankzugriff).
    const guestsByLobby = new Map<number, string[]>();
    for (const lobbies of plan) {
      for (const lobby of lobbies)
        guestsByLobby.set(
          lobby.index,
          Array.from({ length: config.players }, () => randomUUID()),
        );
    }
    if (server !== null) {
      const repos = createRepositories(server.database.client, server.database.collections);
      const all = [...guestsByLobby.values()].flat();
      const created = new Date();
      for (let index = 0; index < all.length; index += 200) {
        await Promise.all(all.slice(index, index + 200).map((guestId) => repos.guests.create(guestId, created)));
      }
      log(`${all.length} guests-Dokumente angelegt`);
    }
    log(
      `${config.lobbies} Lobbys × ${config.players} = ${config.lobbies * config.players} Sockets, ${config.workers} Prozesse, ` +
        `Rampe ${Math.round(config.rampMs / 1_000)} s, Dauer ${Math.round(config.durationMs / 1_000)} s, ` +
        `Spiel ${config.rounds} Runde(n) × ${config.questionsPerCategory} Frage(n), Revanche ${config.rematch ? "an" : "aus"}`,
    );
    const finished = new Promise<void>((resolveAll) => {
      plan.forEach((lobbies, index) => {
        const worker = spawnWorker();
        workers.push(worker);
        worker.on("error", (error) => log(`Generator ${index}: ${error.message}`));
        worker.on("message", (message: FromWorker) => {
          if (message.type === "progress") progress.set(message.worker, message);
          if (message.type === "done") {
            done.set(message.worker, message.stats);
            if (done.size === plan.length) resolveAll();
          }
        });
        worker.on("exit", (code) => {
          if (!done.has(index)) {
            log(`Generator ${index} beendet ohne Ergebnis (Exit ${code ?? "Signal"})`);
            done.set(index, { samples: {}, counters: { generator_lost: 1 } });
            if (done.size === plan.length) resolveAll();
          }
        });
        const workerConfig: WorkerConfig = {
          worker: index,
          target,
          origin,
          ticketSecret,
          lobbies: lobbies.map((lobby) => ({ ...lobby, guests: guestsByLobby.get(lobby.index) ?? [] })),
          players: config.players,
          rounds: config.rounds,
          questionsPerCategory: config.questionsPerCategory,
          rematch: config.rematch,
          timing: config.timing,
          endAt,
        };
        worker.send({ type: "start", config: workerConfig } satisfies ToWorker);
      });
    });

    // Überwachung bis zum Ende (plus Nachlauf, bis alle Generatoren ihre Ergebnisse geliefert haben).
    const rampDoneAt = startAt + config.rampMs;
    while (Date.now() < endAt && !aborted) {
      await new Promise((resolveTick) => setTimeout(resolveTick, MONITOR_INTERVAL_MS));
      const samples = await scrape();
      if (server !== null) {
        const started = performance.now();
        try {
          await server.database.db.command({ ping: 1 });
          observe(dbPing, performance.now() - started);
        } catch (error) {
          log(`DB-Ping fehlgeschlagen: ${error instanceof Error ? error.name : String(error)}`);
        }
      }
      const clients = [...progress.values()].reduce((sum, entry) => sum + entry.connected, 0);
      const point: TimelinePoint = {
        t: Date.now() - startAt,
        sockets: samples === null ? null : seriesValue(samples, "qm_sockets"),
        lobbies: samples === null ? null : seriesValue(samples, "qm_lobbies_active"),
        eventLoopP99Ms:
          samples === null
            ? null
            : (seriesValue(samples, "qm_event_loop_delay_seconds", { quantile: "0.99" }) ?? 0) * 1_000,
        cpuSeconds: samples === null ? null : seriesValue(samples, "qm_process_cpu_seconds_total"),
        rssMb: samples === null ? null : mb(seriesValue(samples, "qm_process_memory_bytes", { type: "rss" })),
        heapMb: samples === null ? null : mb(seriesValue(samples, "qm_process_memory_bytes", { type: "heap_used" })),
        overloaded: samples === null ? null : seriesValue(samples, "qm_overloaded"),
        clients,
      };
      timeline.push(point);
      peakSockets = Math.max(peakSockets, point.sockets ?? 0);
      peakLobbies = Math.max(peakLobbies, point.lobbies ?? 0);
      maxP99 = Math.max(maxP99, point.eventLoopP99Ms ?? 0);
      if (rampEnd === null && Date.now() >= rampDoneAt && samples !== null) rampEnd = samples;
      const problems = [...progress.values()].reduce((sum, entry) => sum + entry.problems, 0);
      const answers = [...progress.values()].reduce((sum, entry) => sum + entry.answers, 0);
      log(
        `t=${String(Math.round(point.t / 1_000)).padStart(4)} s  Sockets ${point.sockets ?? "–"} (Clients ${clients})  ` +
          `Lobbys ${point.lobbies ?? "–"}  EL-p99 ${ms(point.eventLoopP99Ms)} ms  RSS ${ms(point.rssMb, 0)} MB  ` +
          `Antworten ${answers}  Probleme ${problems}`,
      );
    }
    final = await scrape();
    // Die Generatoren beenden sich zum Ende selbst; bei Abbruch hier anstoßen (Kanal kann schon zu sein).
    for (const worker of workers) if (worker.connected) worker.send({ type: "stop" } satisfies ToWorker);
    await Promise.race([finished, new Promise((resolveWait) => setTimeout(resolveWait, 30_000))]);
  } finally {
    for (const worker of workers) if (worker.exitCode === null) worker.kill("SIGTERM");
    if (server !== null) {
      const started = Date.now();
      shutdownResult = await stopProcess(server.proc, 15_000);
      shutdownMs = Date.now() - started;
      try {
        await server.database.cleanup();
        log(`Test-Collections ${server.database.prefix} entfernt`);
      } catch (error) {
        log(`Aufräumen der Test-DB fehlgeschlagen (Janitor nach 6 h): ${error instanceof Error ? error.name : error}`);
      }
    }
  }

  const gc =
    server === null || loadStartAt === null
      ? null
      : retainedHeap(readGcTrace(join(server.logDir, "realtime.log"), server.spawnedAt), {
          loadStartAt,
          steadyFrom: loadStartAt + config.rampMs,
          steadyTo: loadStartAt + config.durationMs,
        });
  const merged = mergeStats([...done.values()]);
  const result = evaluate(config, merged, {
    gc,
    baseline,
    rampEnd,
    final,
    timeline,
    dbPing: summarize(dbPing),
    peakSockets,
    peakLobbies,
    maxP99,
    shutdownMs,
    shutdownResult,
  });
  printResult(result);
  const json = { runId, config: { ...config, target: config.target === null ? "lokal" : "extern" }, ...result };
  const jsonPath = config.json === null ? join(logDir, "result.json") : absolute(config.json);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
  log(`Rohdaten: ${jsonPath}`);
  if (config.report !== null) {
    const reportPath = absolute(config.report);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, markdown(config, result, runId));
    log(`Bericht: ${reportPath}`);
  }
  return result.healthy ? 0 : 3;
}

interface ServerView {
  gc: RetainedHeap | null;
  baseline: PromSample[] | null;
  rampEnd: PromSample[] | null;
  final: PromSample[] | null;
  timeline: TimelinePoint[];
  dbPing: Summary;
  peakSockets: number;
  peakLobbies: number;
  maxP99: number;
  shutdownMs: number | null;
  shutdownResult: string | null;
}

interface Slo {
  name: string;
  target: string;
  measured: string;
  ok: boolean | null;
}

interface LoadtestResult {
  hardware: Record<string, string>;
  client: Record<string, Summary>;
  counters: Record<string, number>;
  server: Record<string, number | string | null>;
  timeline: TimelinePoint[];
  errorRate: number;
  serverErrorRate: number;
  slos: Slo[];
  healthy: boolean;
  healthReasons: string[];
}

function evaluate(config: LoadtestConfig, stats: WorkerStats, view: ServerView): LoadtestResult {
  const client: Record<string, Summary> = {};
  for (const [name, set] of Object.entries(stats.samples)) client[name] = summarize(set);
  const counters = stats.counters;
  const { errorRate, serverErrorRate } = summarizeCounters(counters);

  const { baseline, rampEnd, final } = view;
  const ack = (event: string, q: number) =>
    final === null ? null : histogramQuantile(bucketCounts(final, baseline, "qm_ack_latency_seconds", { event }), q);
  const loopBuckets = final === null ? [] : bucketCounts(final, rampEnd ?? baseline, "qm_event_loop_p99_seconds");
  const steady = view.timeline.filter((point) => point.t >= config.rampMs);
  const cpuStart = steady.find((point) => point.cpuSeconds !== null);
  const cpuEnd = [...steady].reverse().find((point) => point.cpuSeconds !== null);
  const cpuShare =
    cpuStart && cpuEnd && cpuEnd.t > cpuStart.t
      ? ((cpuEnd.cpuSeconds ?? 0) - (cpuStart.cpuSeconds ?? 0)) / ((cpuEnd.t - cpuStart.t) / 1_000)
      : null;
  const heapBase =
    baseline === null ? null : mb(seriesValue(baseline, "qm_process_memory_bytes", { type: "heap_used" }));
  const heapPeak = Math.max(0, ...view.timeline.map((point) => point.heapMb ?? 0));
  const rssPeak = Math.max(0, ...view.timeline.map((point) => point.rssMb ?? 0));
  const stateBytes =
    final === null ? null : bucketCounts(final, baseline, "qm_server_event_bytes", { event: "lobby:state" });
  const stateCount = final === null ? 0 : sumOf(final, "qm_server_event_bytes_count", { event: "lobby:state" });
  const stateSum = final === null ? 0 : sumOf(final, "qm_server_event_bytes_sum", { event: "lobby:state" });
  const mongoErrors =
    final === null
      ? null
      : sumOf(final, "qm_mongo_errors_total") - (baseline ? sumOf(baseline, "qm_mongo_errors_total") : 0);
  const internal =
    final === null
      ? null
      : sumOf(final, "qm_socket_events_total", { outcome: "INTERNAL" }) -
        (baseline ? sumOf(baseline, "qm_socket_events_total", { outcome: "INTERNAL" }) : 0);
  const fastWindows = fractionAtMost(loopBuckets, 0.05);
  const server: Record<string, number | string | null> = {
    peakSockets: view.peakSockets,
    peakLobbies: view.peakLobbies,
    ackAnswerP50Ms: (ack("game:answer", 0.5) ?? Number.NaN) * 1_000,
    ackAnswerP95Ms: (ack("game:answer", 0.95) ?? Number.NaN) * 1_000,
    ackAnswerP99Ms: (ack("game:answer", 0.99) ?? Number.NaN) * 1_000,
    eventLoopP99MaxMs: view.maxP99,
    eventLoopWindowsAtMost50ms: fastWindows,
    eventLoopWindowP99P95Ms: (histogramQuantile(loopBuckets, 0.95) ?? Number.NaN) * 1_000,
    cpuCoresUsed: cpuShare,
    heapBaselineMb: heapBase,
    heapPeakMb: heapPeak,
    rssPeakMb: rssPeak,
    heapPerLobbyKbPeak:
      heapBase === null || view.peakLobbies === 0 ? null : ((heapPeak - heapBase) * 1_024) / view.peakLobbies,
    gcIdleRetainedMb: view.gc?.idleMb ?? null,
    gcSteadyRetainedMb: view.gc?.steadyMb ?? null,
    gcMarkCompacts: view.gc?.markCompacts ?? null,
    gcMaxPauseMs: view.gc?.maxPauseMs ?? null,
    heapPerLobbyKb:
      view.gc?.idleMb == null || view.gc.steadyMb == null || view.peakLobbies === 0
        ? null
        : ((view.gc.steadyMb - view.gc.idleMb) * 1_024) / view.peakLobbies,
    lobbyStateBytesMean: stateCount === 0 ? null : stateSum / stateCount,
    lobbyStateBytesP95: stateBytes === null ? null : histogramQuantile(stateBytes, 0.95),
    lobbyStateBroadcasts: stateCount,
    mongoErrors,
    internalAcks: internal,
    dbPingP50Ms: view.dbPing.p50,
    dbPingP95Ms: view.dbPing.p95,
    dbPingMaxMs: view.dbPing.max,
    shutdownMs: view.shutdownMs,
    shutdownResult: view.shutdownResult,
  };

  const num = (value: number | string | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const verdict = (value: number | null, limit: number) => (value === null ? null : value < limit);
  const sockets = config.lobbies * config.players;
  const broadcast = client.broadcast;
  const slos: Slo[] = [
    {
      name: "Ack-Latenz server-intern game:answer p95",
      target: "< 10 ms",
      measured: `${ms(num(server.ackAnswerP95Ms), 2)} ms`,
      ok: verdict(num(server.ackAnswerP95Ms), 10),
    },
    {
      name: "Ack-Latenz server-intern game:answer p99",
      target: "< 30 ms",
      measured: `${ms(num(server.ackAnswerP99Ms), 2)} ms`,
      ok: verdict(num(server.ackAnswerP99Ms), 30),
    },
    {
      name: "Broadcast bis Client p95",
      target: "< 150 ms",
      measured: `${ms(broadcast?.p95 ?? null)} ms`,
      ok: verdict(broadcast?.p95 ?? null, 150),
    },
    {
      name: "Event-Loop-Verzögerung p99 (5-s-Fenster, Maximum unter Last)",
      target: "< 50 ms",
      measured: `${ms(view.maxP99)} ms (≤ 50 ms in ${fastWindows === null ? "–" : `${Math.round(fastWindows * 100)} %`} der Fenster)`,
      ok: verdict(view.maxP99, 50),
    },
    {
      name: "Gleichzeitige Sockets (2 vCPU)",
      target: "3.000",
      measured: `${view.peakSockets} von ${sockets} geplant`,
      ok: view.peakSockets >= 3_000 ? true : sockets < 3_000 ? null : false,
    },
    {
      name: "Speicher je Lobby inkl. 8 Sockets (Heap nach Mark-Compact, Last − Leerlauf)",
      target: "20–40 KB",
      measured: `${ms(num(server.heapPerLobbyKb))} KB`,
      // Erst ab 50 Lobbys aussagekräftig (darunter überwiegt das Rauschen der Garbage Collection).
      ok: num(server.heapPerLobbyKb) === null || view.peakLobbies < 50 ? null : (num(server.heapPerLobbyKb) ?? 0) <= 40,
    },
    {
      name: "Graceful Shutdown",
      target: "< 10 s",
      measured: view.shutdownMs === null ? "–" : `${ms(view.shutdownMs / 1_000)} s (${view.shutdownResult})`,
      ok: view.shutdownMs === null ? null : view.shutdownMs < 10_000 && view.shutdownResult === "stopped",
    },
  ];

  // „Gesund“ für den nächsten Schritt (1.000 → 3.000): Event-Loop ohne Überlast, Datenbank schnell, keine Fehler.
  const reasons = healthReasons(
    {
      maxP99Ms: view.maxP99,
      fastWindows,
      dbPingP95Ms: view.dbPing.p95,
      mongoErrors,
      serverErrorRate,
      overloaded: view.timeline.some((point) => point.overloaded === 1),
      internalAcks: internal,
    },
    ms,
  );

  return {
    hardware: describeHardware(config),
    client,
    counters,
    server,
    timeline: view.timeline,
    errorRate,
    serverErrorRate,
    slos,
    healthy: reasons.length === 0,
    healthReasons: reasons,
  };
}

function describeHardware(config: LoadtestConfig): Record<string, string> {
  const list = cpus();
  return {
    cpu: `${list[0]?.model ?? "?"} (${list.length} vCPU im Host)`,
    realtimeCpus: config.target === null ? `taskset -c ${config.cpus}` : "extern",
    memory: `${Math.round(totalmem() / 1_073_741_824)} GB`,
    node: process.version,
    timing: config.timing,
    answerMs: String(getTimings(config.timing).answerMs),
  };
}

function printResult(result: LoadtestResult): void {
  console.info("\nClient-Messungen (ms):");
  for (const [name, summary] of Object.entries(result.client).sort(([a], [b]) => a.localeCompare(b))) {
    console.info(
      `  ${name.padEnd(30)} n=${String(summary.count).padStart(7)}  p50 ${ms(summary.p50).padStart(7)}  ` +
        `p95 ${ms(summary.p95).padStart(7)}  p99 ${ms(summary.p99).padStart(7)}  max ${ms(summary.max).padStart(8)}`,
    );
  }
  console.info("\nZähler:");
  for (const [name, value] of Object.entries(result.counters).sort(([a], [b]) => a.localeCompare(b))) {
    console.info(`  ${name.padEnd(40)} ${value}`);
  }
  console.info("\nServer:");
  for (const [name, value] of Object.entries(result.server)) {
    console.info(`  ${name.padEnd(30)} ${typeof value === "number" ? ms(value, 2) : (value ?? "–")}`);
  }
  console.info(
    `\nFehlerquote (alle Ablehnungen): ${ms(result.errorRate * 100, 3)} %  ·  Serverfehler: ${ms(result.serverErrorRate * 100, 3)} %`,
  );
  console.info("\nSLOs (docs/07):");
  for (const slo of result.slos) {
    const status = slo.ok === null ? "–" : slo.ok ? "ok" : "VERFEHLT";
    console.info(`  ${status.padEnd(9)} ${slo.name}: ${slo.measured} (Ziel ${slo.target})`);
  }
  console.info(
    result.healthy
      ? "\nGesund: Event-Loop und Datenbank ohne Auffälligkeiten."
      : `\nNICHT gesund: ${result.healthReasons.join("; ")}`,
  );
}

function markdown(config: LoadtestConfig, result: LoadtestResult, runId: string): string {
  const row = (name: string, summary: Summary | undefined) =>
    summary === undefined
      ? `| ${name} | – | – | – | – | – |`
      : `| ${name} | ${summary.count} | ${ms(summary.p50)} | ${ms(summary.p95)} | ${ms(summary.p99)} | ${ms(summary.max)} |`;
  const lines = [
    `### Lauf ${config.label ?? runId} (${config.lobbies} Lobbys × ${config.players} = ${config.lobbies * config.players} Sockets)`,
    "",
    `Parameter: \`--lobbies ${config.lobbies} --players ${config.players} --duration ${Math.round(config.durationMs / 1_000)}s --ramp ${Math.round(config.rampMs / 1_000)}s --workers ${config.workers} --cpus ${config.cpus} --rounds ${config.rounds} --questions ${config.questionsPerCategory}${config.rematch ? "" : " --no-rematch"} --catalog ${config.catalog} --timing ${config.timing}\``,
    "",
    `Hardware: ${result.hardware.cpu}; Realtime ${result.hardware.realtimeCpus}; RAM ${result.hardware.memory}; Node ${result.hardware.node}.`,
    "",
    "| SLO (docs/07) | Ziel | gemessen | |",
    "|---|---|---|---|",
    ...result.slos.map(
      (slo) =>
        `| ${slo.name} | ${slo.target} | ${slo.measured} | ${slo.ok === null ? "–" : slo.ok ? "erfüllt" : "verfehlt"} |`,
    ),
    "",
    "| Client-Messung (ms) | n | p50 | p95 | p99 | max |",
    "|---|---|---|---|---|---|",
    row("Verbindungsaufbau", result.client.connect),
    ...Object.keys(result.client)
      .filter((name) => name.startsWith("ack:"))
      .sort()
      .map((name) => row(`Ack ${name.slice(4)}`, result.client[name])),
    ...Object.keys(result.client)
      .filter((name) => name.startsWith("state:"))
      .sort()
      .map((name) => row(`bis lobby:state nach ${name.slice(6)}`, result.client[name])),
    row("Broadcast bis Client", result.client.broadcast),
    "",
    `Fehlerquote: ${ms(result.errorRate * 100, 3)} % aller Aktionen abgelehnt, davon Serverfehler ${ms(result.serverErrorRate * 100, 3)} %.`,
    `Server: bis ${result.server.peakSockets} Sockets / ${result.server.peakLobbies} Lobbys, CPU ${ms(typeof result.server.cpuCoresUsed === "number" ? result.server.cpuCoresUsed * 100 : null, 0)} % eines Kerns (stationär), Heap ${ms(result.server.heapBaselineMb as number | null, 0)} → ${ms(result.server.heapPeakMb as number | null, 0)} MB, RSS bis ${ms(result.server.rssPeakMb as number | null, 0)} MB, lobby:state Ø ${ms(result.server.lobbyStateBytesMean as number | null, 0)} B (p95 ${ms(result.server.lobbyStateBytesP95 as number | null, 0)} B, ${result.server.lobbyStateBroadcasts} Broadcasts), Mongo-Fehler ${result.server.mongoErrors ?? "–"}, DB-Ping p95 ${ms(result.server.dbPingP95Ms as number | null)} ms.`,
    `Zähler: ${Object.entries(result.counters)
      .filter(([name]) => !name.startsWith("ok:"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name} ${value}`)
      .join(", ")}.`,
    "",
    result.healthy ? "Bewertung: gesund." : `Bewertung: nicht gesund – ${result.healthReasons.join("; ")}.`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

interface GcEvent {
  /** Absolute Zeit (ms). */
  at: number;
  kind: string;
  afterMb: number;
  pauseMs: number;
}

/** Mark-Compact-Zeilen aus `--trace-gc` (Zeitstempel relativ zum Prozessstart). */
function readGcTrace(path: string, spawnedAt: number): GcEvent[] {
  if (!existsSync(path)) return [];
  const events: GcEvent[] = [];
  const pattern =
    /\]\s+(\d+) ms: ((?:Mark-Compact|Scavenge|Minor Mark-Compact)[^\d]*?) ([\d.]+) \(([\d.]+)\) -> ([\d.]+) \(([\d.]+)\) MB, (?:pooled: [\d.]+ MB, )?([\d.]+) /;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = pattern.exec(line);
    if (match === null) continue;
    events.push({
      at: spawnedAt + Number(match[1]),
      kind: (match[2] ?? "").trim(),
      afterMb: Number(match[5]),
      pauseMs: Number(match[7]),
    });
  }
  return events;
}

interface RetainedHeap {
  /** Heap nach der letzten Mark-Compact vor Lastbeginn. */
  idleMb: number | null;
  /** Median des Heaps nach Mark-Compact im stationären Teil. */
  steadyMb: number | null;
  markCompacts: number;
  maxPauseMs: number | null;
}

function retainedHeap(
  events: readonly GcEvent[],
  window: { loadStartAt: number; steadyFrom: number; steadyTo: number },
): RetainedHeap {
  const major = events.filter((event) => event.kind.startsWith("Mark-Compact"));
  const idle = major.filter((event) => event.at < window.loadStartAt).at(-1)?.afterMb ?? null;
  const steady = major
    .filter((event) => event.at >= window.steadyFrom && event.at <= window.steadyTo)
    .map((event) => event.afterMb)
    .sort((a, b) => a - b);
  const pauses = events.filter((event) => event.at >= window.loadStartAt).map((event) => event.pauseMs);
  return {
    idleMb: idle,
    steadyMb: steady.length === 0 ? null : (steady[Math.floor(steady.length / 2)] ?? null),
    markCompacts: major.filter((event) => event.at >= window.loadStartAt).length,
    maxPauseMs: pauses.length === 0 ? null : Math.max(...pauses),
  };
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`loadtest – ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof ConfigError) console.error(LOADTEST_USAGE);
    process.exit(error instanceof ConfigError ? 2 : 1);
  },
);
