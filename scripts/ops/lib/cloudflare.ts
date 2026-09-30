/**
 * Cloudflare-IP-Bereiche für die Caddy-Site (ADR-024: nur Cloudflare + Loopback dürfen zugreifen).
 * Quelle: https://www.cloudflare.com/ips-v4 und /ips-v6. Jede Liste wird streng geprüft (CIDR-Format,
 * plausible Anzahl, keine zu großen Netze); bei Fehlern gilt die zuletzt gespeicherte Liste
 * (infra/caddy/cloudflare-ips.txt).
 */
import { isIPv4, isIPv6 } from "node:net";

export const CLOUDFLARE_IP_URLS = {
  v4: "https://www.cloudflare.com/ips-v4",
  v6: "https://www.cloudflare.com/ips-v6",
} as const;

export interface CloudflareLists {
  v4: string[];
  v6: string[];
}

/** Plausible Grenzen (Stand 2026: 15 IPv4- und 7 IPv6-Bereiche). */
const LIMITS = { v4: { min: 5, max: 60, minPrefix: 8 }, v6: { min: 3, max: 40, minPrefix: 12 } } as const;

export function isCidr(value: string, family: "v4" | "v6"): boolean {
  const match = /^([^/\s]+)\/(\d{1,3})$/.exec(value);
  if (!match) return false;
  const address = match[1] ?? "";
  const prefix = Number.parseInt(match[2] ?? "", 10);
  if (family === "v4") return isIPv4(address) && prefix >= 0 && prefix <= 32;
  return isIPv6(address) && prefix >= 0 && prefix <= 128;
}

/** Zeilenliste → CIDRs (leere Zeilen und `#`-Kommentare werden übersprungen). Wirft bei ungültigen Zeilen. */
export function parseCidrList(text: string, family: "v4" | "v6"): string[] {
  const cidrs: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!isCidr(line, family)) throw new Error(`ungültiger IP${family}-Bereich in der Liste`);
    cidrs.push(line);
  }
  return cidrs;
}

/** Plausibilitätsprüfung; liefert Probleme (leer = in Ordnung). */
export function validateLists(lists: CloudflareLists): string[] {
  const problems: string[] = [];
  for (const family of ["v4", "v6"] as const) {
    const entries = lists[family];
    const limit = LIMITS[family];
    if (entries.length < limit.min || entries.length > limit.max) {
      problems.push(`IP${family}: ${entries.length} Bereiche (erwartet ${limit.min}–${limit.max})`);
    }
    if (new Set(entries).size !== entries.length) problems.push(`IP${family}: doppelte Einträge`);
    for (const entry of entries) {
      if (!isCidr(entry, family)) {
        problems.push(`IP${family}: ungültiger Bereich`);
        break;
      }
      const prefix = Number.parseInt(entry.split("/")[1] ?? "0", 10);
      if (prefix < limit.minPrefix) problems.push(`IP${family}: ${entry} ist zu groß (Präfix < /${limit.minPrefix})`);
    }
  }
  return problems;
}

/** Gleiche Bereiche (Reihenfolge egal)? */
export function sameLists(a: CloudflareLists, b: CloudflareLists): boolean {
  const key = (lists: CloudflareLists) => `${[...lists.v4].sort().join(",")}|${[...lists.v6].sort().join(",")}`;
  return key(a) === key(b);
}

export function serializeIpFile(lists: CloudflareLists, date: string): string {
  return [
    "# Cloudflare-IP-Bereiche für die Caddy-Site von quizmaster (nur diese + Loopback dürfen zugreifen).",
    "# Quelle: https://www.cloudflare.com/ips-v4 und https://www.cloudflare.com/ips-v6",
    `# Stand: ${date} – gepflegt von infra/caddy/install-site.sh (--refresh-ips); Änderungen committen.`,
    "# [v4]",
    ...lists.v4,
    "# [v6]",
    ...lists.v6,
    "",
  ].join("\n");
}

/** Liest die gespeicherte Liste (Abschnitte `# [v4]` / `# [v6]`, alternativ nach Adressfamilie). */
export function parseIpFile(text: string): CloudflareLists {
  const lists: CloudflareLists = { v4: [], v6: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (isCidr(line, "v4")) lists.v4.push(line);
    else if (isCidr(line, "v6")) lists.v6.push(line);
    else throw new Error("cloudflare-ips.txt enthält eine ungültige Zeile");
  }
  return lists;
}

/** Holt beide Listen (HTTPS, Zeitlimit, keine Umleitungen). Wirft bei Netz- oder Formatfehlern. */
export async function fetchLists(fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<CloudflareLists> {
  const get = async (url: string) => {
    const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 64 * 1024) throw new Error(`${url}: Antwort zu groß`);
    return text;
  };
  const [v4, v6] = await Promise.all([get(CLOUDFLARE_IP_URLS.v4), get(CLOUDFLARE_IP_URLS.v6)]);
  return { v4: parseCidrList(v4, "v4"), v6: parseCidrList(v6, "v6") };
}
