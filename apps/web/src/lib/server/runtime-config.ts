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
}

/** Reine Ableitung aus der Env (testbar, ohne Next-Kontext). */
export function publicRuntimeConfigFrom(env: Pick<WebEnv, "realtimeUrl" | "turnstile">): PublicRuntimeConfig {
  const configured = env.turnstile.siteKey !== undefined && env.turnstile.secretKey !== undefined;
  return {
    realtimeUrl: env.realtimeUrl,
    turnstile: {
      enabled: env.turnstile.enabled,
      siteKey: configured ? (env.turnstile.siteKey ?? null) : null,
    },
  };
}

/**
 * Öffentliche Laufzeit-Konfiguration – nur in Server-Komponenten/Route-Handlern aufrufen. Markiert die
 * Route als dynamisch (`connection()`): Werte kommen immer aus der Laufzeit-Env, nie aus dem Build.
 */
export function getPublicRuntimeConfig(): PublicRuntimeConfig {
  // Im Prerender (Build) bricht connection() synchron ab → Route wird dynamisch; zur Laufzeit ein No-op.
  void connection();
  return publicRuntimeConfigFrom(getWebEnv());
}

/**
 * CSP-Nonce des aktuellen Requests (gesetzt von `proxy.ts`), z. B. für `<Script nonce>`. `null`, wenn der
 * Proxy für diesen Pfad nicht läuft. Macht die Route dynamisch.
 */
export async function getRequestNonce(): Promise<string | null> {
  return (await headers()).get(NONCE_HEADER);
}
