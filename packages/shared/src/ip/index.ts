/**
 * Subpath "@quizmaster/shared/ip" – SERVER-ONLY: Client-IP und IP-Schlüssel (docs/06 §IP-Adressen richtig
 * behandeln). Web, Realtime und Admin-Skripte müssen denselben Schlüssel bilden, sonst greifen Limits und
 * IP-Bans (`bans.kind = "ip"`) nicht übergreifend. Rohe IPs werden nie gespeichert oder geloggt.
 */
import { createHmac } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";

/** Länge des gekürzten Schlüssels in Hex-Zeichen (128 Bit). */
export const IP_KEY_HEX_LENGTH = 32;

/** Header-Werte wie in `node:http` (`IncomingHttpHeaders`) oder als Web-`Headers` vorab ausgelesen. */
export type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Echte Client-IP: aus `trustedHeader` (z. B. `cf-connecting-ip`) NUR, wenn er konfiguriert ist – der
 * Server ist dann ausschließlich über den Proxy erreichbar (docs/06); sonst die Socket-Adresse.
 * Liefert eine gültige IP oder `null` (fail-closed: Aufrufer behandeln `null` wie einen gemeinsamen Schlüssel
 * bzw. lehnen ab).
 */
export function resolveClientIp(
  headers: HeaderBag,
  trustedHeader: string | undefined,
  remoteAddress: string | undefined,
): string | null {
  const candidate = trustedHeader ? firstHeaderValue(headers[trustedHeader.toLowerCase()]) : remoteAddress;
  if (!candidate) return null;
  const ip = stripZone(candidate.trim());
  return isIPv4(ip) || isIPv6(ip) ? ip : null;
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  const raw = typeof value === "string" ? value : value?.[0];
  // Bei Listen (X-Forwarded-For-Stil) zählt der erste Eintrag; cf-connecting-ip enthält genau eine IP.
  return raw?.split(",")[0]?.trim();
}

function stripZone(ip: string): string {
  const percent = ip.indexOf("%");
  return percent === -1 ? ip : ip.slice(0, percent);
}

/** Zerlegt eine IPv6-Adresse in 8 Gruppen (0–65535); `null`, wenn ungültig. */
function ipv6Groups(ip: string): number[] | null {
  if (!isIPv6(ip)) return null;
  let text = ip.toLowerCase();
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".").map(Number);
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = rest ? rest.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array<string>(rest === undefined ? 0 : missing).fill("0"), ...tailGroups];
  if (groups.length !== 8) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * Normalisierter Schlüssel-Gegenstand: IPv4 unverändert, IPv4-mapped IPv6 (`::ffff:1.2.3.4`) als IPv4,
 * sonstiges IPv6 als /64-Präfix („2001:db8:1:2::/64“) – Angreifer rotieren innerhalb eines /64.
 */
export function ipKeySubject(ip: string): string | null {
  const address = stripZone(ip.trim());
  if (isIPv4(address)) return address;
  const groups = ipv6Groups(address);
  if (!groups) return null;
  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMapped) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** `HMAC-SHA256(IP_HASH_SECRET, subject)` als Hex, gekürzt; `null` bei ungültiger IP. */
export function ipKey(ip: string, secret: string): string | null {
  if (secret.length < 32) throw new RangeError("IP_HASH_SECRET muss mindestens 32 Zeichen haben");
  const subject = ipKeySubject(ip);
  if (subject === null) return null;
  return createHmac("sha256", secret).update(subject).digest("hex").slice(0, IP_KEY_HEX_LENGTH);
}
