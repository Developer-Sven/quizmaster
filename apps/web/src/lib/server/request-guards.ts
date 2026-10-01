/**
 * Anfrage-Prüfungen der Web-API: Origin gegen `APP_ORIGIN` (CSRF-Schutz zusätzlich zu SameSite, docs/06
 * §Identität) und Client-IP bzw. IP-Schlüssel (docs/06 §IP-Adressen). Rohe IPs werden nie gespeichert oder
 * geloggt – nur an Cloudflare Siteverify (`remoteip`) weitergegeben.
 */
import { isAllowedOrigin } from "@quizmaster/shared";
import { type HeaderBag, ipKey, resolveClientIp } from "@quizmaster/shared/ip";
import type { WebEnv } from "../../env";
import { ApiError } from "./http";

/**
 * Wirft 403, wenn der `Origin` fehlt, ungültig oder fremd ist (fail-closed; Browser senden bei POST immer
 * `Origin`). Die ADR-028-Ausnahme gilt nur für Realtime, nicht hier.
 */
export function assertAllowedOrigin(headers: Headers, env: Pick<WebEnv, "appOrigins">): void {
  const allowed = isAllowedOrigin(
    { origin: headers.get("origin"), secFetchSite: headers.get("sec-fetch-site") },
    env.appOrigins,
  );
  // ERROR_CODES kennt keinen eigenen Code für CSRF-Ablehnungen → UNAUTHORIZED mit HTTP 403 (Forbidden).
  if (!allowed) throw new ApiError("UNAUTHORIZED", "Origin nicht erlaubt", { status: 403 });
}

/** Gemeinsamer Schlüssel, wenn keine IP bestimmbar ist – nie 4xx deswegen. */
export const UNKNOWN_IP_KEY = "unknown";

export interface ClientAddress {
  /** Gültige Client-IP oder `null` (nie loggen). */
  ip: string | null;
  /** HMAC-IP-Schlüssel (Rate-Limits, IP-Bans) oder `UNKNOWN_IP_KEY`. */
  key: string;
  /** true, wenn `key` aus einer echten IP stammt (dann auch für IP-Bans nutzbar). */
  resolved: boolean;
}

/**
 * Socket-Adresse aus Sicht von Next: Der Next-Server setzt `x-forwarded-for` auf die Socket-Adresse,
 * wenn der Header fehlt (Route Handler sehen den Socket nicht). Hinter Caddy steht dort die Peer-IP.
 */
function remoteAddress(headers: Headers): string | undefined {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
}

function headerBag(headers: Headers, trustedHeader: string | undefined): HeaderBag {
  if (trustedHeader === undefined) return {};
  const value = headers.get(trustedHeader);
  return value === null ? {} : { [trustedHeader.toLowerCase()]: value };
}

/**
 * Client-IP: aus `TRUSTED_IP_HEADER` (nur gesetzt, wenn der Server ausschließlich über den Proxy erreichbar
 * ist); fehlt der Header oder ist er ungültig → Socket-/Remote-Adresse.
 */
export function resolveRequestIp(headers: Headers, trustedHeader: string | undefined): string | null {
  const remote = remoteAddress(headers);
  const fromTrusted = resolveClientIp(headerBag(headers, trustedHeader), trustedHeader, remote);
  if (fromTrusted !== null || trustedHeader === undefined) return fromTrusted;
  return resolveClientIp({}, undefined, remote);
}

export function clientAddress(headers: Headers, env: Pick<WebEnv, "trustedIpHeader" | "ipHashSecret">): ClientAddress {
  const ip = resolveRequestIp(headers, env.trustedIpHeader);
  const key = ip === null ? null : ipKey(ip, env.ipHashSecret);
  return key === null ? { ip: null, key: UNKNOWN_IP_KEY, resolved: false } : { ip, key, resolved: true };
}
