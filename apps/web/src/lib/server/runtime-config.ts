/**
 * Laufzeit-Konfiguration für Client-Komponenten (ADR-023): Server-Komponenten lesen sie zur Laufzeit und
 * geben sie als Props weiter – keine beim Build ins Bundle eingesetzten öffentlichen Env-Variablen, kein
 * Inline-Script. Enthält NUR öffentliche Werte.
 */
import { headers } from "next/headers";
import { connection } from "next/server";
import { getWebEnv, type WebEnv } from "../../env";
import { NONCE_HEADER } from "./security-headers";

export interface PublicRuntimeConfig {
  /** Socket.IO-Ziel; "" = gleiche Origin (Produktion). */
  realtimeUrl: string;
  turnstile: {
    /** true = `POST /api/session` verlangt für eine NEUE Session ein Turnstile-Token. */
    enabled: boolean;
    /**
     * Site Key, sobald Turnstile konfiguriert ist (auch für den Notfall-Schalter `turnstileOnJoin`, wenn
     * `enabled` false ist); sonst `null`.
     */
    siteKey: string | null;
  };
  /** „Bot hinzufügen“ anbieten (`DEV_BOTS_ENABLED`, nur Dev/Test – Realtime registriert `dev:add-bot` ebenso). */
  devBots: boolean;
}

/** Reine Ableitung aus der Env (testbar, ohne Next-Kontext). */
export function publicRuntimeConfigFrom(
  env: Pick<WebEnv, "realtimeUrl" | "turnstile" | "devBots">,
): PublicRuntimeConfig {
  const configured = env.turnstile.siteKey !== undefined && env.turnstile.secretKey !== undefined;
  return {
    realtimeUrl: env.realtimeUrl,
    turnstile: {
      enabled: env.turnstile.enabled,
      siteKey: configured ? (env.turnstile.siteKey ?? null) : null,
    },
    devBots: env.devBots,
  };
}

/**
 * Öffentliche Laufzeit-Konfiguration – nur in Server-Komponenten/Route-Handlern aufrufen. Wartet auf den
 * Request (`await connection()`, Next-CSP-Leitfaden): Werte kommen immer aus der Laufzeit-Env, nie aus dem
 * Build, und die Seite wird nie statisch vorgerendert (Nonce-CSP, ADR-008).
 */
export async function getPublicRuntimeConfig(): Promise<PublicRuntimeConfig> {
  await connection();
  return publicRuntimeConfigFrom(getWebEnv());
}

/**
 * CSP-Nonce des aktuellen Requests (gesetzt von `proxy.ts`), z. B. für `<Script nonce>`. `null`, wenn der
 * Proxy für diesen Pfad nicht läuft. Macht die Route dynamisch.
 */
export async function getRequestNonce(): Promise<string | null> {
  return (await headers()).get(NONCE_HEADER);
}
