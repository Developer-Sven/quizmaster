import { describe, expect, it } from "vitest";
import { cspNonce, evaluatePageHeaders, HSTS_MIN_MAX_AGE, parseCsp, type RawHeader } from "./headers.ts";

const NONCE = "S1NCKUIsFHQu/0NNZJyskQ==";

/** Header der Startseite wie von proxy.ts + next.config.ts (docs/06) geliefert. */
function pageHeaders(overrides: Record<string, string | null> = {}, https = true): RawHeader[] {
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' wss://quizmaster.dev-sven.de https://quizmaster.dev-sven.de https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "worker-src 'self'",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  const base: Record<string, string | null> = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": csp,
    "strict-transport-security": https ? `max-age=${HSTS_MIN_MAX_AGE}; includeSubDomains` : null,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate, no-transform",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    ...overrides,
  };
  return Object.entries(base)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([name, value]) => ({ name, value }));
}

function failed(headers: RawHeader[], https = true): string[] {
  return evaluatePageHeaders(headers, { https })
    .checks.filter((check) => !check.ok)
    .map((check) => check.id);
}

describe("evaluatePageHeaders", () => {
  it("akzeptiert die Header nach docs/06 (https) und liefert die Nonce", () => {
    const evaluation = evaluatePageHeaders(pageHeaders(), { https: true });
    expect(evaluation.checks.filter((check) => !check.ok)).toEqual([]);
    expect(evaluation.nonce).toBe(NONCE);
    expect(evaluation.cspHeaders).toBe(1);
    expect(evaluation.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(["hsts", "csp-upgrade-insecure-requests", "permissions-policy", "cache-control"]),
    );
  });

  it("verlangt HSTS und upgrade-insecure-requests nur bei https", () => {
    const http = evaluatePageHeaders(pageHeaders({}, false), { https: false });
    expect(http.checks.filter((check) => !check.ok)).toEqual([]);
    expect(http.checks.map((check) => check.id)).not.toContain("hsts");
    expect(failed(pageHeaders({}, false), true)).toEqual(["csp-upgrade-insecure-requests", "hsts"]);
  });

  it("findet schwache HSTS-Werte", () => {
    expect(failed(pageHeaders({ "strict-transport-security": "max-age=300; includeSubDomains" }))).toEqual(["hsts"]);
    expect(failed(pageHeaders({ "strict-transport-security": `max-age=${HSTS_MIN_MAX_AGE}` }))).toEqual(["hsts"]);
  });

  it("findet eine CSP ohne Nonce, mit unsicheren Quellen oder ohne Pflicht-Direktiven", () => {
    const csp = (policy: string) => failed(pageHeaders({ "content-security-policy": policy }));
    expect(csp("default-src 'self'; script-src 'self' 'unsafe-inline'")).toEqual(
      expect.arrayContaining([
        "csp-nonce",
        "csp-strict-dynamic",
        "csp-no-unsafe-script",
        "csp-object-src",
        "csp-base-uri",
        "csp-frame-ancestors",
      ]),
    );
    expect(failed(pageHeaders({ "content-security-policy": null }))).toEqual(
      expect.arrayContaining(["csp", "csp-nonce", "csp-default-src"]),
    );
  });

  it("vergleicht Permissions-Policy unabhängig von Reihenfolge und Leerzeichen", () => {
    const shuffled = "usb=(),camera=(self), browsing-topics=(),geolocation=(), payment=(), microphone=()";
    expect(failed(pageHeaders({ "permissions-policy": shuffled }))).toEqual([]);
    expect(failed(pageHeaders({ "permissions-policy": "camera=(self), microphone=()" }))).toEqual([
      "permissions-policy",
    ]);
  });

  it("verlangt no-store und no-transform im Cache-Control des HTML", () => {
    expect(failed(pageHeaders({ "cache-control": "private, no-store" }))).toEqual(["cache-control"]);
    expect(failed(pageHeaders({ "cache-control": "public, max-age=300, no-transform" }))).toEqual(["cache-control"]);
  });

  it("lässt mehrfach gesendete Header nur gelten, wenn jeder Wert passt", () => {
    const doubled = [...pageHeaders(), { name: "X-Frame-Options", value: "SAMEORIGIN" }];
    expect(failed(doubled)).toEqual(["x-frame-options"]);
    const same = [...pageHeaders(), { name: "X-Content-Type-Options", value: "nosniff" }];
    expect(failed(same)).toEqual([]);
  });

  it("meldet X-Powered-By", () => {
    expect(failed([...pageHeaders(), { name: "X-Powered-By", value: "Next.js" }])).toEqual(["x-powered-by"]);
  });
});

describe("parseCsp und cspNonce", () => {
  it("zerlegt Direktiven, die erste gewinnt", () => {
    const directives = parseCsp("script-src 'self'; Script-Src 'unsafe-inline'; object-src 'none';");
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
  });

  it("erkennt nur Nonces mit mindestens 128 Bit", () => {
    expect(cspNonce(parseCsp(`script-src 'nonce-${NONCE}'`))).toBe(NONCE);
    expect(cspNonce(parseCsp("script-src 'nonce-abc123'"))).toBeNull();
  });
});
