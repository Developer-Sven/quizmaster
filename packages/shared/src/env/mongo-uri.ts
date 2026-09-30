/**
 * Transport-Eigenschaften einer MongoDB-URI – ohne Treiber, für die Env-Regeln (docs/04, docs/06: „TLS
 * erzwingen“). Die maßgebliche Prüfung zur Laufzeit macht `runStartChecks` in `@quizmaster/db` anhand der
 * vom Treiber geparsten Optionen; diese Funktion liest dieselben Schalter aus dem URI-Text.
 */

export interface MongoUriTransport {
  /** TLS an: `mongodb+srv://` standardmäßig, sonst `tls=true` bzw. `ssl=true` (ein `false` gewinnt). */
  tls: boolean;
  /** TLS mit Zertifikats- und Hostnamenprüfung (kein `tlsInsecure`/`tlsAllowInvalid*=true`). */
  verified: boolean;
  /** Alle Hosts lokal (localhost, 127.0.0.0/8, ::1, Unix-Socket) – der Verkehr verlässt den Rechner nicht. */
  loopbackOnly: boolean;
}

const INSECURE_TLS_OPTIONS = ["tlsinsecure", "tlsallowinvalidcertificates", "tlsallowinvalidhostnames"];
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|::1)$/i;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Host ohne Port („[::1]:27017“ → „::1“); Unix-Sockets bleiben als Pfad („/tmp/mongodb-27017.sock“). */
function hostName(entry: string): string {
  const host = safeDecode(entry);
  if (host.startsWith("/")) return host;
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]") === -1 ? undefined : host.indexOf("]"));
  return host.split(":")[0] ?? "";
}

function isLoopbackHost(host: string): boolean {
  return host.startsWith("/") || LOOPBACK_HOST.test(host);
}

export function mongoUriTransport(uri: string): MongoUriTransport {
  const match = /^mongodb(\+srv)?:\/\/(?:[^@/?#]*@)?([^/?#]*)[^?#]*(?:\?([^#]*))?/i.exec(uri.trim());
  if (!match) return { tls: false, verified: false, loopbackOnly: false };
  const srv = match[1] !== undefined;
  const params = new Map<string, string[]>();
  for (const pair of (match[3] ?? "").split(/[&;]/)) {
    if (pair === "") continue;
    const [rawKey = "", ...rest] = pair.split("=");
    const key = safeDecode(rawKey).toLowerCase();
    params.set(key, [...(params.get(key) ?? []), safeDecode(rest.join("=")).toLowerCase()]);
  }
  const flags = [...(params.get("tls") ?? []), ...(params.get("ssl") ?? [])];
  const tls = flags.includes("false") ? false : srv || flags.includes("true");
  const insecure = INSECURE_TLS_OPTIONS.some((key) => (params.get(key) ?? []).includes("true"));
  const hosts = srv
    ? []
    : (match[2] ?? "")
        .split(",")
        .filter((entry) => entry !== "")
        .map(hostName);
  return { tls, verified: tls && !insecure, loopbackOnly: hosts.length > 0 && hosts.every(isLoopbackHost) };
}
