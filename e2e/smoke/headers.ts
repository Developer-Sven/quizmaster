/**
 * Sicherheits-Header der Startseite (docs/06 §HTTP-Sicherheitsheader & CSP, ADR-008): reine Auswertung der
 * Antwort-Header eines HTML-Dokuments. Geprüft wird, was jede Instanz liefern muss – egal, ob Cloudflare, Caddy
 * oder `next start` davor steht.
 */

export interface RawHeader {
  name: string;
  value: string;
}

export interface HeaderCheck {
  id: string;
  /** Anzeige im Bericht, z. B. „CSP: script-src mit Nonce“ */
  label: string;
  ok: boolean;
  /** gefundener Wert (gekürzt), `null` = Header fehlt */
  actual: string | null;
  expected: string;
}

export interface HeaderEvaluation {
  checks: HeaderCheck[];
  /** Nonce aus `script-src` (für den Abgleich mit den Skripten der Seite), sonst `null` */
  nonce: string | null;
  /** Anzahl `Content-Security-Policy`-Header */
  cspHeaders: number;
}

/** docs/06: `Permissions-Policy` – jede Fähigkeit gesperrt. */
export const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "browsing-topics=()",
] as const;

/** docs/06: HSTS `max-age=63072000; includeSubDomains` (2 Jahre). */
export const HSTS_MIN_MAX_AGE = 63_072_000;

/** 128 Bit Zufall als Base64 = mindestens 22 Zeichen (`createNonce()` in apps/web). */
const NONCE_PATTERN = /^'nonce-([A-Za-z0-9+/_-]{22,}={0,2})'$/;

const MAX_ACTUAL_LENGTH = 300;

function shorten(value: string): string {
  return value.length > MAX_ACTUAL_LENGTH ? `${value.slice(0, MAX_ACTUAL_LENGTH)} …` : value;
}

/** Alle Werte eines Headers (Groß-/Kleinschreibung egal), mehrfach gesendete getrennt. */
export function headerValues(headers: readonly RawHeader[], name: string): string[] {
  const wanted = name.toLowerCase();
  return headers.filter((header) => header.name.toLowerCase() === wanted).map((header) => header.value.trim());
}

/** CSP in Direktiven zerlegen: `script-src 'self' 'nonce-…'` → `{ "script-src": ["'self'", "'nonce-…'"] }`. */
export function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (!name) continue;
    const key = name.toLowerCase();
    // Doppelte Direktiven ignoriert der Browser – die erste gilt.
    if (!directives.has(key)) directives.set(key, values);
  }
  return directives;
}

/** Nonce aus `script-src`, falls vorhanden. */
export function cspNonce(directives: ReadonlyMap<string, readonly string[]>): string | null {
  for (const source of directives.get("script-src") ?? []) {
    const match = NONCE_PATTERN.exec(source);
    if (match?.[1]) return match[1];
  }
  return null;
}

function cacheDirectives(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(",")
      .map((directive) => directive.trim().split("=")[0] ?? "")
      .filter((directive) => directive !== ""),
  );
}

function hstsMaxAge(value: string): number | null {
  const match = /(?:^|;)\s*max-age\s*=\s*"?(\d+)"?/i.exec(value);
  return match?.[1] ? Number(match[1]) : null;
}

function exactCheck(
  headers: readonly RawHeader[],
  id: string,
  name: string,
  expected: string,
  compare: (value: string) => boolean = (value) => value.toLowerCase() === expected.toLowerCase(),
): HeaderCheck {
  const values = headerValues(headers, name);
  const actual = values.length > 0 ? values.join(", ") : null;
  // Mehrfach gesendet (z. B. von einem Proxy ergänzt) zählt nur, wenn jeder Wert passt.
  const ok = values.length > 0 && values.every(compare);
  return { id, label: name, ok, actual: actual === null ? null : shorten(actual), expected };
}

/**
 * Wertet die Header eines HTML-Dokuments aus. `https`: Die Instanz läuft unter https – dann sind HSTS und
 * `upgrade-insecure-requests` Pflicht (über http sendet die App sie bewusst nicht).
 */
export function evaluatePageHeaders(headers: readonly RawHeader[], options: { https: boolean }): HeaderEvaluation {
  const checks: HeaderCheck[] = [];
  const cspValues = headerValues(headers, "content-security-policy");
  const policy = cspValues[0] ?? null;
  const directives = parseCsp(policy ?? "");
  const nonce = cspNonce(directives);
  const scriptSources = directives.get("script-src") ?? [];
  const csp = (id: string, label: string, ok: boolean, expected: string, actual: string | null): void => {
    checks.push({ id: `csp-${id}`, label: `CSP: ${label}`, ok: policy !== null && ok, actual, expected });
  };
  const directiveText = (name: string): string | null => {
    const values = directives.get(name);
    return values === undefined ? null : `${name} ${values.join(" ")}`.trim();
  };

  checks.push({
    id: "csp",
    label: "Content-Security-Policy",
    ok: policy !== null,
    actual: policy === null ? null : shorten(cspValues.join(" | ")),
    expected: "CSP nach docs/06 (nonce-basiert)",
  });
  csp("nonce", "script-src mit Nonce", nonce !== null, "'nonce-<mind. 128 Bit>'", directiveText("script-src"));
  csp(
    "strict-dynamic",
    "script-src mit 'strict-dynamic'",
    scriptSources.includes("'strict-dynamic'"),
    "'strict-dynamic'",
    directiveText("script-src"),
  );
  csp(
    "no-unsafe-script",
    "script-src ohne 'unsafe-inline'/'unsafe-eval'",
    !scriptSources.includes("'unsafe-inline'") && !scriptSources.includes("'unsafe-eval'"),
    "weder 'unsafe-inline' noch 'unsafe-eval'",
    directiveText("script-src"),
  );
  for (const [name, expected] of [
    ["default-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["frame-ancestors", "'none'"],
  ] as const) {
    const values = directives.get(name) ?? [];
    csp(
      name,
      `${name} ${expected}`,
      values.length === 1 && values[0] === expected,
      `${name} ${expected}`,
      directiveText(name),
    );
  }
  if (options.https) {
    csp(
      "upgrade-insecure-requests",
      "upgrade-insecure-requests",
      directives.has("upgrade-insecure-requests"),
      "upgrade-insecure-requests (bei https)",
      directiveText("upgrade-insecure-requests"),
    );
  }

  const hsts = headerValues(headers, "strict-transport-security");
  if (options.https) {
    const value = hsts[0] ?? null;
    const maxAge = value === null ? null : hstsMaxAge(value);
    checks.push({
      id: "hsts",
      label: "Strict-Transport-Security",
      ok: value !== null && maxAge !== null && maxAge >= HSTS_MIN_MAX_AGE && /includesubdomains/i.test(value),
      actual: value,
      expected: `max-age=${HSTS_MIN_MAX_AGE}; includeSubDomains`,
    });
  }

  checks.push(exactCheck(headers, "nosniff", "X-Content-Type-Options", "nosniff"));
  checks.push(exactCheck(headers, "referrer-policy", "Referrer-Policy", "strict-origin-when-cross-origin"));
  const wantedPermissions = [...PERMISSIONS_POLICY].sort().join(",");
  checks.push(
    exactCheck(
      headers,
      "permissions-policy",
      "Permissions-Policy",
      PERMISSIONS_POLICY.join(", "),
      (value) =>
        value
          .split(",")
          .map((entry) => entry.trim().toLowerCase().replace(/\s+/g, ""))
          .filter((entry) => entry !== "")
          .sort()
          .join(",") === wantedPermissions,
    ),
  );
  checks.push(
    exactCheck(
      headers,
      "cache-control",
      "Cache-Control",
      "no-store, no-transform (HTML mit Nonce, ADR-008)",
      (value) => {
        const set = cacheDirectives(value);
        return set.has("no-store") && set.has("no-transform");
      },
    ),
  );
  checks.push(exactCheck(headers, "x-frame-options", "X-Frame-Options", "DENY"));
  checks.push(exactCheck(headers, "coop", "Cross-Origin-Opener-Policy", "same-origin"));
  checks.push(exactCheck(headers, "corp", "Cross-Origin-Resource-Policy", "same-origin"));
  const poweredBy = headerValues(headers, "x-powered-by");
  checks.push({
    id: "x-powered-by",
    label: "X-Powered-By",
    ok: poweredBy.length === 0,
    actual: poweredBy.length > 0 ? poweredBy.join(", ") : null,
    expected: "nicht gesendet (poweredByHeader: false)",
  });
  return { checks, nonce, cspHeaders: cspValues.length };
}
