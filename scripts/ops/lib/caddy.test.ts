import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderSite, type SiteValues } from "./caddy.ts";
import { parseIpFile } from "./cloudflare.ts";

const root = resolve(import.meta.dirname, "../../..");
const template = readFileSync(join(root, "infra", "caddy", "quizmaster.caddy.template"), "utf8");
const ips = parseIpFile(readFileSync(join(root, "infra", "caddy", "cloudflare-ips.txt"), "utf8"));

const values: SiteValues = {
  domain: "quiz.example.com",
  webPort: 7400,
  realtimePort: 7401,
  certFile: "/etc/ssl/example/origin.pem",
  keyFile: "/etc/ssl/example/origin.key",
  cloudflareIps: [...ips.v4, ...ips.v6],
  ipsNote: "Cloudflare-IP-Bereiche: 15 IPv4 + 7 IPv6 (Stand 2026-10-01)",
};

/** Zeilen ohne Kommentare. */
const directives = (site: string) =>
  site
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

describe("Caddy-Site aus dem Template", () => {
  const site = renderSite(template, values);
  const lines = directives(site);

  it("Site mit Origin-Zertifikat und Allowlist nur für Cloudflare + Loopback", () => {
    expect(lines[0]).toBe("quiz.example.com {");
    expect(lines).toContain("tls /etc/ssl/example/origin.pem /etc/ssl/example/origin.key");
    const blocked = lines.find((line) => line.startsWith("@blocked"));
    expect(blocked).toBe(`@blocked not remote_ip ${values.cloudflareIps.join(" ")} 127.0.0.1/8 ::1`);
  });

  it("Routing: erst abort, dann /metrics → 404, dann Realtime, zuletzt Web", () => {
    const route = lines.slice(lines.indexOf("route {"));
    const order = [
      "abort @blocked",
      "respond @metrics 404",
      "reverse_proxy @realtime 127.0.0.1:7401 {",
      "reverse_proxy 127.0.0.1:7400 {",
    ];
    const positions = order.map((directive) => route.indexOf(directive));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(lines).toContain("@realtime path /socket.io/* /healthz");
    expect(lines).toContain("@metrics path /metrics /metrics/*");
    expect(lines).toContain("stream_close_delay 5m");
  });

  it("beide Upstreams überbrücken Neustartlücken statt sofort 502 zu liefern", () => {
    expect(lines.filter((line) => line === "lb_try_duration 8s")).toHaveLength(2);
    expect(lines.filter((line) => line === "lb_try_interval 250ms")).toHaveLength(2);
  });

  it("keine Access-Logs, keine Kompression, Fehler ohne IP-haltiges Fehlerlog, keine offenen Platzhalter", () => {
    expect(lines.some((line) => /^(log|encode)\b/.test(line))).toBe(false);
    // handle_errors senkt das Fehlerlog (mit Cf-Connecting-Ip) auf Debug, Status bleibt erhalten.
    const errors = lines.slice(lines.indexOf("handle_errors {"));
    expect(errors[1]).toBe('respond "" {err.status_code}');
    expect(lines.indexOf("handle_errors {")).toBeGreaterThan(lines.indexOf("route {"));
    expect(site).not.toMatch(/\{\{|\}\}/);
  });

  it("lehnt Werte ab, die die Caddyfile-Syntax verlassen könnten", () => {
    expect(() => renderSite(template, { ...values, certFile: "/etc/ssl/a b.pem" })).toThrow(/TLS_CERT_FILE/);
    expect(() => renderSite(template, { ...values, keyFile: "/etc/ssl/}{.key" })).toThrow(/TLS_KEY_FILE/);
    expect(() => renderSite(template, { ...values, domain: "quiz.example.com {\n}" })).toThrow(/QUIZMASTER_DOMAIN/);
    expect(() => renderSite(template, { ...values, cloudflareIps: ["0.0.0.0/0 }"] })).toThrow(/ungültigen Bereich/);
    expect(() => renderSite(template, { ...values, realtimePort: 7400 })).toThrow(/PORT_CONFLICT/);
    expect(() => renderSite(`${template}\n{{UNBEKANNT}}`, values)).toThrow(/unbekannter Platzhalter/);
  });
});
