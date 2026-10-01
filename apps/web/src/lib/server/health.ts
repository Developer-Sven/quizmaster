/**
 * Health-Probe für `GET /api/health` (docs/06: Antwort ohne Details): kurzer `ping` an MongoDB mit Frist,
 * Ergebnis ~5 s gecacht, gleichzeitige Anfragen teilen sich einen laufenden Ping.
 */
import type { Logger } from "pino";

export const HEALTH_CACHE_MS = 5_000;
export const HEALTH_PING_TIMEOUT_MS = 2_000;

export interface HealthProbe {
  /** true = Datenbank erreichbar. Wirft nie. */
  check(): Promise<boolean>;
}

export interface HealthProbeOptions {
  ping: () => Promise<unknown>;
  logger: Logger;
  now?: () => number;
  cacheMs?: number;
  timeoutMs?: number;
}

/** Wartet höchstens `ms`; der Ping läuft ggf. weiter, seine Ablehnung wird abgefangen. */
async function pingWithin(ping: () => Promise<unknown>, ms: number): Promise<{ ok: boolean; detail?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; detail: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, detail: `keine Antwort in ${ms} ms` }), ms);
  });
  const attempt = (async () => {
    try {
      await ping();
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.name : "Fehler" };
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createHealthProbe(options: HealthProbeOptions): HealthProbe {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? HEALTH_CACHE_MS;
  const timeoutMs = options.timeoutMs ?? HEALTH_PING_TIMEOUT_MS;
  let cached: { ok: boolean; at: number } | undefined;
  let inflight: Promise<boolean> | undefined;

  const run = async (): Promise<boolean> => {
    const result = await pingWithin(options.ping, timeoutMs);
    // Zustandswechsel loggen, nicht jede Anfrage.
    if (cached === undefined || cached.ok !== result.ok) {
      if (result.ok) options.logger.info("Health: Datenbank erreichbar");
      else options.logger.warn({ detail: result.detail }, "Health: Datenbank nicht erreichbar");
    }
    cached = { ok: result.ok, at: now() };
    return result.ok;
  };

  return {
    check() {
      if (cached !== undefined && now() - cached.at < cacheMs) return Promise.resolve(cached.ok);
      inflight ??= run().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
