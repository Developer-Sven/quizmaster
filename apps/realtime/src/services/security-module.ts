/**
 * Modul „Sicherheit“ (docs/06 §DDoS-Schicht 6, §Notfall-Runbook; docs/04 §Change-Stream-Watcher): verbindet die
 * Kill-Switches und Sperren mit dem laufenden Server.
 *
 * - Watcher `appConfig` → `services.appConfig.apply` (live: Wartungsmodus, `lobbyCreationEnabled`,
 *   `turnstileOnJoin`, `maxActiveLobbies`, `minClientProtocol`, `blockedTerms`).
 * - Watcher `bans` → `services.bans.disconnectBanned` (sofortige Trennung mit `kicked { abuse }`).
 * - Reaktionen auf Konfigurationswechsel: Wartung an → `notice MAINTENANCE` an alle (Banner im Web); neue
 *   Verbindungen während der Wartung bekommen den Hinweis direkt nach dem Verbinden. `minClientProtocol` erhöht →
 *   Sockets älterer Clients trennen; ihr Neuverbindungsversuch endet mit `UPDATE_REQUIRED` („Neue Version“).
 * - Sicherheitsnetz (Standard alle 5 min): appConfig neu laden und alle Verbindungen gegen die Sperren abgleichen –
 *   falls ein Stream unbemerkt hängt.
 *
 * Start (`onStart`, vor `listen`): Streams öffnen, höchstens `openTimeoutMs` auf „offen“ warten, DANACH den
 * Anfangsbestand laden (Vertrag von `watchWithResume`). Öffnet ein Stream nicht rechtzeitig, startet der Server
 * trotzdem (die Ban-Prüfung im Handshake schützt neue Verbindungen weiter) – Fehlerlog und Metrik
 * `qm_change_stream_restarts_total{stream, reason="open_timeout"}`; der Stream versucht es im Hintergrund weiter.
 */
import type { WatchHandle } from "@quizmaster/db";
import { handshakeAuthSchema } from "@quizmaster/shared";
import type { AppConfigDoc } from "@quizmaster/shared/documents";
import type { AppSocket, ModuleContext, RealtimeModule } from "../registry/types.ts";
import { APP_CONFIG_STREAM, startAppConfigWatcher } from "../watchers/app-config.ts";
import { BANS_STREAM, startBansWatcher } from "../watchers/bans.ts";
import { sweepConnectedSockets } from "./bans.ts";

/** Abstand des Sicherheitsnetzes (appConfig neu laden, Verbindungen gegen Sperren abgleichen). */
export const SECURITY_SAFETY_NET_INTERVAL_MS = 5 * 60_000;
/** Höchstwartezeit auf das Öffnen der Streams beim Start. */
export const SECURITY_WATCH_OPEN_TIMEOUT_MS = 10_000;

export interface SecurityModuleOptions {
  /** Nur Tests: kürzere Neustart-Pausen der Change Streams. */
  watchBackoff?: { initialMs?: number; maxMs?: number };
  safetyNetIntervalMs?: number;
  openTimeoutMs?: number;
}

/** Protokollversion eines verbundenen Sockets (aus dem geprüften Handshake) oder `null`. */
export function socketProtocolVersion(socket: Pick<AppSocket, "handshake">): number | null {
  const auth = handshakeAuthSchema.safeParse(socket.handshake.auth);
  return auth.success ? auth.data.protocolVersion : null;
}

/** Felder, deren Wechsel geloggt wird (ohne Inhalte der Blockliste oder des Wartungstexts). */
function switchSummary(config: Readonly<AppConfigDoc>) {
  return {
    maintenance: config.maintenance.enabled,
    lobbyCreationEnabled: config.lobbyCreationEnabled,
    turnstileOnJoin: config.turnstileOnJoin,
    maxActiveLobbies: config.maxActiveLobbies,
    minClientProtocol: config.minClientProtocol,
    blockedTerms: config.blockedTerms.length,
  };
}

function sameSwitches(a: Readonly<AppConfigDoc>, b: Readonly<AppConfigDoc>): boolean {
  const left = switchSummary(a);
  const right = switchSummary(b);
  return (
    (Object.keys(left) as Array<keyof typeof left>).every((key) => left[key] === right[key]) &&
    a.maintenance.message === b.maintenance.message &&
    a.blockedTerms.every((term, index) => b.blockedTerms[index] === term)
  );
}

function runSecurityModule(context: ModuleContext, options: SecurityModuleOptions): void {
  const { io, db, logger, clock, services } = context;
  const intervalMs = options.safetyNetIntervalMs ?? SECURITY_SAFETY_NET_INTERVAL_MS;
  const openTimeoutMs = options.openTimeoutMs ?? SECURITY_WATCH_OPEN_TIMEOUT_MS;
  let watchers: WatchHandle[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const sweep = () =>
    sweepConnectedSockets({ repo: db.repos.bans, connections: services.connections, bans: services.bans, clock });

  /** Trennt Sockets mit älterer Protokollversion; sie bekommen beim Neuverbinden `UPDATE_REQUIRED`. */
  const disconnectOutdated = (minProtocol: number): number => {
    let count = 0;
    for (const socket of services.connections.all()) {
      const version = socketProtocolVersion(socket);
      if (version !== null && version >= minProtocol) continue;
      socket.disconnect(true);
      count += 1;
    }
    return count;
  };

  context.onConnection((socket) => {
    if (services.appConfig.get().maintenance.enabled) socket.emit("notice", { code: "MAINTENANCE" });
  });

  /** Reaktionen auf Konfigurationswechsel (Watcher, Sicherheitsnetz, Start). */
  const onConfigChange = (next: Readonly<AppConfigDoc>, previous: Readonly<AppConfigDoc>) => {
    if (sameSwitches(next, previous)) return;
    logger.warn({ appConfig: switchSummary(next) }, "appConfig live übernommen");
    if (next.maintenance.enabled && !previous.maintenance.enabled) io.emit("notice", { code: "MAINTENANCE" });
    if (next.minClientProtocol > previous.minClientProtocol) {
      const sockets = disconnectOutdated(next.minClientProtocol);
      if (sockets > 0)
        logger.warn({ sockets, minClientProtocol: next.minClientProtocol }, "Veraltete Clients getrennt");
    }
  };
  let unsubscribe: (() => void) | undefined;

  /** Anfangsbestand bzw. Sicherheitsnetz: Fehler werden geloggt und gezählt, nie geworfen. */
  const reconcile = async (label: "start" | "safety_net") => {
    const results = await Promise.allSettled([services.appConfig.load(), sweep()]);
    const [config, swept] = results;
    if (config.status === "rejected") {
      services.metrics.recordMongoError("app_config_load");
      logger.error({ err: config.reason, label }, "appConfig nicht geladen – die bisherige Konfiguration gilt weiter");
    }
    if (swept.status === "rejected") {
      services.metrics.recordMongoError("ban_sweep");
      logger.error({ err: swept.reason, label }, "Abgleich der Verbindungen mit den Sperren fehlgeschlagen");
    } else if (swept.value > 0) {
      logger.warn({ sockets: swept.value, label }, "Abgleich: gesperrte Verbindungen getrennt");
    }
  };

  // `setup` registriert nur Hooks (lauffähig mit Teil-Kontext, vgl. Registry-Tests) – Dienste erst ab `onStart`.
  context.onStart(async () => {
    unsubscribe = services.appConfig.onChange(onConfigChange);
    logger.info({ appConfig: switchSummary(services.appConfig.get()) }, "Kill-Switches beim Start");
    const backoff = options.watchBackoff === undefined ? {} : { backoff: options.watchBackoff };
    const bans = startBansWatcher({
      collection: db.collections.bans,
      bans: services.bans,
      sweep,
      clock,
      logger,
      metrics: services.metrics,
      security: services.security,
      ...backoff,
    });
    const appConfig = startAppConfigWatcher({
      collection: db.collections.appConfig,
      appConfig: services.appConfig,
      logger,
      metrics: services.metrics,
      ...backoff,
    });
    watchers = [bans, appConfig];
    const streams = [
      { name: BANS_STREAM, handle: bans },
      { name: APP_CONFIG_STREAM, handle: appConfig },
    ];
    const open = new Set<string>();
    for (const stream of streams) void stream.handle.ready.then(() => open.add(stream.name));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), openTimeoutMs);
    });
    const opened = await Promise.race([Promise.all(streams.map((stream) => stream.handle.ready)), timedOut]);
    clearTimeout(timeout);
    if (opened === "timeout") {
      const pending = streams.filter((stream) => !open.has(stream.name)).map((stream) => stream.name);
      for (const name of pending) services.metrics.recordChangeStreamRestart(name, "open_timeout");
      logger.error(
        { timeoutMs: openTimeoutMs, streams: pending },
        "Sicherheits-Watcher nicht rechtzeitig offen – Kill-Switches bzw. Sperren erst später live",
      );
      // Sobald die Streams doch offen sind, den Anfangsbestand nachholen.
      void Promise.all(streams.map((stream) => stream.handle.ready)).then(() =>
        stopped ? undefined : reconcile("start"),
      );
    } else {
      await reconcile("start");
    }
    timer = setInterval(() => {
      void reconcile("safety_net");
    }, intervalMs);
    timer.unref();
  });

  context.onShutdown(async () => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    unsubscribe?.();
    const results = await Promise.allSettled(watchers.map((watcher) => watcher.close()));
    for (const result of results) {
      if (result.status === "rejected")
        logger.warn({ err: result.reason }, "Sicherheits-Watcher nicht sauber geschlossen");
    }
  });
}

export function createSecurityModule(options: SecurityModuleOptions = {}): RealtimeModule {
  return {
    name: "security",
    setup(context) {
      runSecurityModule(context, options);
    },
  };
}

/** Standard-Instanz für `REALTIME_MODULES`. */
export const securityModule: RealtimeModule = createSecurityModule();
