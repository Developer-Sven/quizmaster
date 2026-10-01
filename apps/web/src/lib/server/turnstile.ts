/**
 * Cloudflare Turnstile – serverseitige Prüfung (docs/06 §Bot-Schutz): Siteverify mit `secret`, `response`,
 * `remoteip` und `idempotency_key` (erlaubt einen sicheren Wiederholungsversuch), Hostname-Prüfung gegen
 * `APP_ORIGIN`, jedes Token nur einmal (Cloudflare prüft das; zusätzlich lokaler Replay-Schutz).
 * Fail-closed: Nur `success: true` mit passendem Hostname gilt. Das Secret bleibt ausschließlich in apps/web.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import { TURNSTILE_TEST_SECRET_KEYS } from "../../env";

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Tokens sind 300 s gültig – so lange merken wir verbrauchte Tokens lokal. */
export const TURNSTILE_TOKEN_TTL_MS = 300_000;
const REPLAY_CACHE_MAX = 50_000;
const ATTEMPT_TIMEOUT_MS = 3_500;
const MAX_ATTEMPTS = 2;

/**
 * Siteverify-Fehlercodes, mit denen Cloudflare die eigene Konfiguration ablehnt statt des Tokens: Secret fehlt,
 * ist ungültig/rotiert (bzw. ein Test-Secret mit echtem Token) oder die Anfrage ist fehlerhaft. Dann scheitert
 * jede Prüfung – wie „nicht verfügbar“ behandeln (503, fail-closed) und mit der Ursache loggen, statt jede Person
 * als Bot abzuweisen (403 sähe aus wie eine normale Ablehnung) oder nur „nicht verfügbar“ zu melden (sähe aus wie
 * ein Cloudflare-Ausfall). Live antwortet Siteverify darauf mit HTTP 400, laut Doku auch mit 200 – beides zählt.
 */
const CONFIGURATION_ERROR_CODES: ReadonlySet<string> = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "bad-request",
]);

const siteverifyResponseSchema = z.object({
  success: z.boolean(),
  "error-codes": z.array(z.string()).optional(),
  hostname: z.string().optional(),
  challenge_ts: z.string().optional(),
});

export type TurnstileOutcome =
  | { ok: true; verifiedAt: number }
  | { ok: false; reason: "rejected" | "hostname_mismatch" | "replayed"; errorCodes?: readonly string[] }
  /**
   * Siteverify nicht erreichbar, fehlerhaft oder lehnt die eigene Konfiguration ab (Secret, siehe
   * `CONFIGURATION_ERROR_CODES`) → Aufrufer antwortet 503 (fail-closed).
   */
  | { ok: false; reason: "unavailable" };

export interface TurnstileVerifier {
  verify(token: string, remoteIp: string | null): Promise<TurnstileOutcome>;
}

export interface TurnstileVerifierOptions {
  secretKey: string;
  /** Erlaubte Hostnamen (aus `APP_ORIGIN`). */
  allowedHostnames: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  logger: Logger;
  attemptTimeoutMs?: number;
}

type AttemptResult =
  | { kind: "answer"; data: z.output<typeof siteverifyResponseSchema> }
  /** Siteverify lehnt die eigene Konfiguration ab (`CONFIGURATION_ERROR_CODES`). */
  | { kind: "config"; errorCodes: readonly string[] }
  | { kind: "retry"; detail: string }
  | { kind: "fail"; detail: string };

export function hostnamesOf(origins: readonly string[]): string[] {
  return [...new Set(origins.map((origin) => new URL(origin).hostname.toLowerCase()))];
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createTurnstileVerifier(options: TurnstileVerifierOptions): TurnstileVerifier {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  // Cloudflare-Test-Secrets (env.ts, nur mit *_dev/*_test-DB erlaubt) melden einen Platzhalter-Hostnamen –
  // die Hostname-Prüfung entfällt nur für sie.
  const checkHostname = !TURNSTILE_TEST_SECRET_KEYS.includes(options.secretKey);
  const allowed = new Set(options.allowedHostnames.map((host) => host.toLowerCase()));
  /** Verbrauchte Tokens (sha256) → Ablaufzeitpunkt. */
  const used = new Map<string, number>();

  const prune = (at: number) => {
    for (const [digest, expiresAt] of used) {
      if (expiresAt <= at) used.delete(digest);
    }
    while (used.size >= REPLAY_CACHE_MAX) {
      const oldest = used.keys().next();
      if (oldest.done) break;
      used.delete(oldest.value);
    }
  };

  const attempt = async (body: URLSearchParams): Promise<AttemptResult> => {
    let response: Response;
    try {
      response = await fetchImpl(TURNSTILE_SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { kind: "retry", detail: error instanceof Error ? error.name : "fetch-fehler" };
    }
    if (response.status >= 500) return { kind: "retry", detail: `HTTP ${response.status}` };
    // Auch 4xx-Antworten tragen die Fehlercodes im Body: Ein falsches oder fehlendes Secret meldet Siteverify mit
    // HTTP 400 + `invalid-input-secret` bzw. `missing-input-secret` (live geprüft); jede andere 4xx bleibt „fail“.
    const status = `HTTP ${response.status}`;
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { kind: "fail", detail: response.ok ? "Antwort ist kein JSON" : status };
    }
    const parsed = siteverifyResponseSchema.safeParse(json);
    if (!parsed.success) return { kind: "fail", detail: response.ok ? "Antwort unerwartet" : status };
    const errorCodes = parsed.data.success ? [] : (parsed.data["error-codes"] ?? []);
    if (errorCodes.some((code) => CONFIGURATION_ERROR_CODES.has(code))) return { kind: "config", errorCodes };
    if (!response.ok) return { kind: "fail", detail: status };
    if (errorCodes.includes("internal-error")) return { kind: "retry", detail: "internal-error" };
    return { kind: "answer", data: parsed.data };
  };

  return {
    async verify(token, remoteIp) {
      const digest = tokenDigest(token);
      const startedAt = now();
      prune(startedAt);
      if (used.has(digest)) return { ok: false, reason: "replayed" };

      // Gleicher idempotency_key für beide Versuche → Cloudflare wertet eine Wiederholung nicht als Replay.
      const body = new URLSearchParams({ secret: options.secretKey, response: token, idempotency_key: randomUUID() });
      if (remoteIp !== null) body.set("remoteip", remoteIp);

      let last: AttemptResult | undefined;
      for (let round = 1; round <= MAX_ATTEMPTS; round++) {
        last = await attempt(body);
        if (last.kind !== "retry") break;
      }
      if (last?.kind === "config") {
        options.logger.error(
          { errorCodes: last.errorCodes },
          "Turnstile-Siteverify lehnt die Konfiguration ab – TURNSTILE_SECRET_KEY prüfen (jede Prüfung scheitert)",
        );
        return { ok: false, reason: "unavailable" };
      }
      if (last === undefined || last.kind !== "answer") {
        options.logger.error({ detail: last?.detail }, "Turnstile-Siteverify nicht verfügbar");
        return { ok: false, reason: "unavailable" };
      }
      const data = last.data;
      if (!data.success) {
        const errorCodes = data["error-codes"] ?? [];
        return { ok: false, reason: errorCodes.includes("timeout-or-duplicate") ? "replayed" : "rejected", errorCodes };
      }
      if (checkHostname && (data.hostname === undefined || !allowed.has(data.hostname.toLowerCase()))) {
        return { ok: false, reason: "hostname_mismatch" };
      }
      const verifiedAt = now();
      used.set(digest, verifiedAt + TURNSTILE_TOKEN_TTL_MS);
      return { ok: true, verifiedAt };
    },
  };
}
