/**
 * Rendert die Caddy-Site aus infra/caddy/quizmaster.caddy.template. Alle Werte werden streng geprüft, damit
 * nichts die Caddyfile-Syntax verlassen kann (keine Leerzeichen, Klammern, Anführungszeichen in Pfaden).
 */
import { isCidr } from "./cloudflare.ts";

export interface SiteValues {
  domain: string;
  webPort: number;
  realtimePort: number;
  certFile: string;
  keyFile: string;
  cloudflareIps: readonly string[];
  ipsNote: string;
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const SAFE_NOTE = /^[\p{L}\p{N} .,:;()/–+-]*$/u;

export function validateSiteValues(values: SiteValues): string[] {
  const problems: string[] = [];
  if (!HOSTNAME.test(values.domain)) problems.push("QUIZMASTER_DOMAIN: kein gültiger Hostname");
  for (const [key, port] of [
    ["QUIZMASTER_PORT", values.webPort],
    ["REALTIME_PORT", values.realtimePort],
  ] as const) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) problems.push(`${key}: ungültiger Port`);
  }
  if (values.webPort === values.realtimePort) problems.push("PORT_CONFLICT: Web- und Realtime-Port gleich");
  for (const [key, path] of [
    ["TLS_CERT_FILE", values.certFile],
    ["TLS_KEY_FILE", values.keyFile],
  ] as const) {
    if (!SAFE_PATH.test(path) || path.includes("..")) {
      problems.push(`${key}: absoluter Pfad nur aus A–Z, a–z, 0–9, ., _, -, / erwartet`);
    }
  }
  if (values.cloudflareIps.length === 0) problems.push("Cloudflare-IP-Liste ist leer");
  for (const cidr of values.cloudflareIps) {
    if (!isCidr(cidr, "v4") && !isCidr(cidr, "v6")) {
      problems.push("Cloudflare-IP-Liste enthält einen ungültigen Bereich");
      break;
    }
  }
  if (!SAFE_NOTE.test(values.ipsNote)) problems.push("Hinweistext enthält unzulässige Zeichen");
  return problems;
}

export function renderSite(template: string, values: SiteValues): string {
  const problems = validateSiteValues(values);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const replacements: Record<string, string> = {
    DOMAIN: values.domain,
    WEB_PORT: String(values.webPort),
    REALTIME_PORT: String(values.realtimePort),
    TLS_CERT_FILE: values.certFile,
    TLS_KEY_FILE: values.keyFile,
    CLOUDFLARE_IPS: values.cloudflareIps.join(" "),
    IPS_NOTE: values.ipsNote,
  };
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) => {
    const value = replacements[key];
    if (value === undefined) throw new Error(`unbekannter Platzhalter ${placeholder} im Template`);
    return value;
  });
  if (/\{\{[^}]*\}\}/.test(rendered)) throw new Error("Template enthält nicht ersetzte Platzhalter");
  return rendered;
}
