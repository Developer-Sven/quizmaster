/**
 * Origin-Prüfung (docs/05 §Verbindung 3, docs/06 §Identität „CSRF“, ADR-028) als reine Funktion, damit
 * Web (POST /api/session, /api/realtime/ticket) und Realtime (`allowRequest`) exakt dieselbe Regel nutzen.
 * Fail-closed: fehlende, ungültige oder „null“-Origins werden abgelehnt.
 */

export interface OriginRequestHeaders {
  /** Wert des `Origin`-Headers. */
  origin?: string | null | undefined;
  /** Wert von `Sec-Fetch-Site` (nur für die Ausnahme aus ADR-028). */
  secFetchSite?: string | null | undefined;
}

export interface OriginCheckOptions {
  /**
   * ADR-028: Same-Origin-GETs (Socket.IO-Long-Polling) senden keinen `Origin`. Nur für `allowRequest`
   * des Realtime-Servers `true` – dann gilt fehlender Origin mit `Sec-Fetch-Site: same-origin` als erlaubt
   * (das Ticket bleibt Pflicht). Web-POST-Routen lassen es aus (Browser senden bei POST immer Origin).
   */
  allowMissingWhenSameOrigin?: boolean;
}

/** Kanonische Origin (`scheme://host[:port]`, klein, ohne Standard-Port) oder `null`, wenn ungültig. */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!/^https?:\/\/[^/\s]+$/i.test(trimmed) || !URL.canParse(trimmed)) return null;
  return new URL(trimmed).origin;
}

/** true, wenn die Anfrage von einer erlaubten Origin (APP_ORIGIN-Liste) stammt. */
export function isAllowedOrigin(
  headers: OriginRequestHeaders,
  allowedOrigins: readonly string[],
  options: OriginCheckOptions = {},
): boolean {
  const origin = headers.origin?.trim();
  if (!origin) {
    return options.allowMissingWhenSameOrigin === true && headers.secFetchSite?.trim().toLowerCase() === "same-origin";
  }
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return false;
  return allowedOrigins.some((allowed) => normalizeOrigin(allowed) === normalized);
}
