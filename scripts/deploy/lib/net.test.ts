import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkSiteViaCaddy,
  judgeConnectPackets,
  judgeStartPage,
  parseSsListeners,
  splitPollingPayload,
} from "./net.ts";

describe("parseSsListeners", () => {
  it("liest Adresse, Port und PIDs aus `ss -Hltnp`", () => {
    const output = [
      'LISTEN 0      511        127.0.0.1:7400       0.0.0.0:*    users:(("node",pid=4242,fd=21))',
      'LISTEN 0      511            [::1]:7401          [::]:*    users:(("node",pid=4243,fd=19),("node",pid=4250,fd=19))',
      'LISTEN 0      4096               *:443              *:*    users:(("caddy",pid=900,fd=7))',
      "",
    ].join("\n");
    expect(parseSsListeners(output)).toEqual([
      { address: "127.0.0.1", port: 7400, pids: [4242], processName: "node" },
      { address: "[::1]", port: 7401, pids: [4243, 4250], processName: "node" },
      { address: "*", port: 443, pids: [900], processName: "caddy" },
    ]);
  });

  it("verträgt Zeilen ohne Prozessangabe", () => {
    expect(parseSsListeners("LISTEN 0 128 0.0.0.0:22 0.0.0.0:*")).toEqual([
      { address: "0.0.0.0", port: 22, pids: [], processName: null },
    ]);
  });
});

describe("Socket.IO-Handshake ohne Ticket", () => {
  it("zerlegt Polling-Antworten am Trenner U+001E", () => {
    expect(splitPollingPayload('2\u001e44{"message":"UNAUTHORIZED"}')).toEqual(["2", '44{"message":"UNAUTHORIZED"}']);
  });

  it("nur CONNECT_ERROR mit UNAUTHORIZED ist ein Erfolg", () => {
    expect(judgeConnectPackets(['44{"message":"UNAUTHORIZED","data":{"code":"UNAUTHORIZED"}}'])).toEqual({
      ok: true,
      detail: "UNAUTHORIZED",
    });
    expect(judgeConnectPackets(['44{"message":"SERVER_BUSY"}'])?.ok).toBe(false);
    expect(judgeConnectPackets(["44kaputt"])?.ok).toBe(false);
    expect(judgeConnectPackets(["6"])).toBeNull();
  });

  it("eine angenommene Verbindung ohne Ticket ist ein Sicherheitsfehler", () => {
    const verdict = judgeConnectPackets(['40{"sid":"abc"}']);
    expect(verdict?.ok).toBe(false);
    expect(verdict?.detail).toContain("OHNE Ticket angenommen");
  });
});

describe("judgeStartPage", () => {
  const nonce = "q0LUw2Hc7fM+Hy0p/vU9xQ==";
  const page = (overrides: { status?: number; headers?: Record<string, string>; body?: string } = {}) => ({
    status: overrides.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
      ...overrides.headers,
    },
    body:
      overrides.body ??
      `<!DOCTYPE html><html><head><script src="/_next/static/chunks/main-app.js?v=1" async="" nonce="${nonce}"></script></head></html>`,
  });

  it("HTML mit CSP-Nonce, die die Skripte tragen → ok + erstes /_next/static-Asset (ohne Query)", () => {
    expect(judgeStartPage(page())).toEqual({
      ok: true,
      detail: "HTML mit CSP-Nonce",
      asset: "/_next/static/chunks/main-app.js",
    });
  });

  it("erkennt die Fehlerbilder, die /api/health nicht zeigt", () => {
    expect(judgeStartPage(page({ status: 500 })).detail).toBe("HTTP 500");
    expect(judgeStartPage(page({ headers: { "content-type": "application/json" } })).ok).toBe(false);
    expect(judgeStartPage(page({ headers: { "content-security-policy": "default-src 'self'" } })).detail).toContain(
      "ohne Nonce",
    );
    // Statisch gerendert / Nonce nicht angewendet: Browser blockiert die Skripte.
    const noNonce = page({ body: '<script src="/_next/static/chunks/a.js"></script>' });
    expect(judgeStartPage(noNonce).detail).toContain("nicht die Nonce");
    const noAsset = page({ body: `<script nonce="${nonce}">self.__next_f=[]</script>` });
    expect(judgeStartPage(noAsset).detail).toContain("keine /_next/static-Referenz");
  });
});

describe("checkSiteViaCaddy", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-caddy-check-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const cert = (name: string) => {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=quiz.example.com",
        "-addext",
        "subjectAltName=DNS:quiz.example.com",
        "-keyout",
        join(dir, `${name}.key`),
        "-out",
        join(dir, `${name}.pem`),
      ],
      { stdio: "ignore" },
    );
    return join(dir, `${name}.pem`);
  };

  it("prüft Status über SNI/Host und vergleicht das ausgelieferte Zertifikat mit TLS_CERT_FILE", async () => {
    const served = cert("served");
    const other = cert("other");
    const hosts: string[] = [];
    const server = createServer(
      { key: readFileSync(join(dir, "served.key")), cert: readFileSync(served) },
      (req, res) => {
        hosts.push(String(req.headers.host));
        res.writeHead(req.url === "/api/health" ? 200 : 404).end('{"ok":true}');
      },
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    try {
      const options = { domain: "quiz.example.com", path: "/api/health", timeoutMs: 5_000, port };
      expect(await checkSiteViaCaddy({ ...options, certFile: served })).toEqual({
        status: 200,
        certificateMatches: true,
      });
      expect(await checkSiteViaCaddy({ ...options, certFile: other })).toEqual({
        status: 200,
        certificateMatches: false,
      });
      expect(await checkSiteViaCaddy({ ...options, certFile: join(dir, "fehlt.pem") })).toEqual({
        status: 200,
        certificateMatches: null,
      });
      expect((await checkSiteViaCaddy({ ...options, path: "/x", certFile: served })).status).toBe(404);
      expect(hosts[0]).toBe("quiz.example.com");
    } finally {
      server.close();
    }
  });
});
