/**
 * Netzwerk-Prüfungen für Preflight und Smoke-Test: Port-Belegung (`ss`), HTTP-Health und der
 * Socket.IO-Handshake ohne Ticket, der mit UNAUTHORIZED abgelehnt werden muss (beweist, dass /socket.io
 * vom Realtime-Prozess bedient wird und die Auth-Middleware greift – docs/05, docs/06, ADR-028).
 */
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { type IncomingHttpHeaders, request } from "node:http";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { io } from "socket.io-client";
import { DeployError } from "./log.ts";
import { run, SYSTEM_PATH } from "./proc.ts";

export interface Listener {
  address: string;
  port: number;
  pids: number[];
  processName: string | null;
}

/** Wertet `ss -Hltnp` aus (eine Zeile je lauschendem Socket). */
export function parseSsListeners(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4 || columns[0] !== "LISTEN") continue;
    const local = columns[3] ?? "";
    const separator = local.lastIndexOf(":");
    if (separator === -1) continue;
    const port = Number.parseInt(local.slice(separator + 1), 10);
    if (!Number.isInteger(port)) continue;
    const users = columns.slice(5).join(" ");
    const pids = [...users.matchAll(/pid=(\d+)/g)].map((match) => Number.parseInt(match[1] ?? "0", 10));
    const name = /\(\("([^"]+)"/.exec(users)?.[1] ?? null;
    listeners.push({ address: local.slice(0, separator), port, pids, processName: name });
  }
  return listeners;
}

export async function listListeners(): Promise<Listener[]> {
  // Eigene Prozessgruppe: Strg+C/SIGHUP am Terminal darf die Prüfung mitten im Smoke-Test nicht beenden.
  const result = await run("ss", ["-Hltnp"], {
    env: { PATH: SYSTEM_PATH, LANG: "C" },
    output: "capture",
    timeoutMs: 15_000,
    isolate: true,
  });
  if (result.code !== 0) throw new DeployError("SS_FAILED", "ss -Hltnp fehlgeschlagen");
  return parseSsListeners(result.stdout);
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const MAX_BODY = 64 * 1024;

export function httpRequest(options: {
  method: "GET" | "POST";
  host: string;
  port: number;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Höchstens so viele Zeichen des Körpers lesen (Standard 64 KiB; HTML der Startseite: mehr). */
  maxBody?: number;
}): Promise<HttpResponse> {
  const maxBody = options.maxBody ?? MAX_BODY;
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        method: options.method,
        host: options.host,
        port: options.port,
        path: options.path,
        headers: {
          ...options.headers,
          ...(options.body === undefined ? {} : { "content-length": String(Buffer.byteLength(options.body)) }),
        },
        timeout: options.timeoutMs,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < maxBody) body += chunk;
        });
        res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Zeitüberschreitung")));
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export interface HealthResult {
  ok: boolean;
  attempts: number;
  detail: string;
}

/**
 * Wartet, bis `GET path` 200 liefert (und – falls JSON mit `ok` – `ok: true`). Liefert das letzte Ergebnis.
 */
export async function waitForHealth(
  host: string,
  port: number,
  path: string,
  timeoutMs: number,
  intervalMs = 1_000,
): Promise<HealthResult> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let detail = "keine Antwort";
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const response = await httpRequest({ method: "GET", host, port, path, timeoutMs: 5_000 });
      if (response.status === 200) {
        let healthy = true;
        try {
          const parsed = JSON.parse(response.body) as unknown;
          if (typeof parsed === "object" && parsed !== null && "ok" in parsed) {
            healthy = (parsed as { ok: unknown }).ok === true;
          }
        } catch {
          // kein JSON – Status 200 genügt
        }
        if (healthy) return { ok: true, attempts, detail: "HTTP 200" };
        detail = "HTTP 200, aber ok ≠ true";
      } else detail = `HTTP ${response.status}`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, intervalMs));
  }
  return { ok: false, attempts, detail };
}

export interface StartPageVerdict {
  ok: boolean;
  detail: string;
  /** Erstes im HTML referenziertes /_next/static-Asset (wird anschließend abgerufen). */
  asset: string | null;
}

/**
 * Startseite wie ein Browser sie braucht (docs/12 §CI/CD Punkt 4, ADR-008): 200 als HTML, eine CSP mit Nonce,
 * und die Skripte im HTML tragen genau diese Nonce – sonst blockiert der Browser sie (z. B. statisch statt
 * dynamisch gerendert oder proxy.ts nicht aktiv). Liefert das erste /_next/static-Asset zur Folgeprüfung.
 */
export function judgeStartPage(response: HttpResponse): StartPageVerdict {
  const fail = (detail: string): StartPageVerdict => ({ ok: false, detail, asset: null });
  if (response.status !== 200) return fail(`HTTP ${response.status}`);
  const type = String(response.headers["content-type"] ?? "");
  if (!type.startsWith("text/html")) return fail(`Content-Type ${type || "fehlt"} statt text/html`);
  const csp = String(response.headers["content-security-policy"] ?? "");
  const nonce = /'nonce-([A-Za-z0-9+/_=-]+)'/.exec(csp)?.[1];
  if (nonce === undefined) return fail("Content-Security-Policy ohne Nonce (proxy.ts aktiv?)");
  if (!response.body.includes(`nonce="${nonce}"`)) {
    return fail("Skripte im HTML tragen nicht die Nonce der CSP – der Browser würde sie blockieren");
  }
  const asset = /(?:src|href)="(\/_next\/static\/[^"?#\s]+)/.exec(response.body)?.[1] ?? null;
  if (asset === null) return fail("keine /_next/static-Referenz im HTML");
  return { ok: true, detail: "HTML mit CSP-Nonce", asset };
}

export interface SiteCheck {
  status: number;
  /** Liefert Caddy genau das Zertifikat aus TLS_CERT_FILE? (null = Zertifikatsdatei nicht lesbar) */
  certificateMatches: boolean | null;
}

/**
 * `GET https://<domain><path>` über den Host-Caddy auf 127.0.0.1:443 (SNI + Host = Domain; Loopback ist in der
 * Caddy-Site erlaubt). Das Cloudflare-Origin-Zertifikat ist nicht öffentlich vertrauenswürdig – statt der
 * CA-Prüfung wird das ausgelieferte Zertifikat mit TLS_CERT_FILE verglichen (Pinning, nur zur Kontrolle).
 */
export function checkSiteViaCaddy(options: {
  domain: string;
  path: string;
  certFile: string | undefined;
  timeoutMs: number;
  /** Standard 443 (Host-Caddy); andere Ports nur für Tests. */
  port?: number;
}): Promise<SiteCheck> {
  let expected: string | null = null;
  try {
    if (options.certFile) expected = new X509Certificate(readFileSync(options.certFile)).fingerprint256;
  } catch {
    expected = null;
  }
  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest(
      {
        method: "GET",
        host: "127.0.0.1",
        port: options.port ?? 443,
        path: options.path,
        servername: options.domain,
        headers: { host: options.domain },
        timeout: options.timeoutMs,
        agent: false,
        // Bewusst: nur Loopback zum eigenen Caddy; geprüft wird per Fingerabdruck gegen TLS_CERT_FILE (s. o.).
        rejectUnauthorized: false,
      },
      (res) => {
        const peer = (res.socket as TLSSocket).getPeerCertificate();
        res.resume();
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            certificateMatches: expected === null ? null : peer.fingerprint256 === expected,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Zeitüberschreitung")));
    req.on("error", reject);
    req.end();
  });
}

export interface HandshakeResult {
  ok: boolean;
  detail: string;
}

/** Engine.IO-v4-Pakete eines Polling-Antwortkörpers (Trenner U+001E). */
export function splitPollingPayload(body: string): string[] {
  return body.split("\u001e").filter((packet) => packet !== "");
}

/**
 * Bewertet die Pakete nach dem CONNECT ohne Ticket: nur `44{"message":"UNAUTHORIZED",…}` ist ein Erfolg;
 * `40…` (Verbindung angenommen) ist ein Sicherheitsfehler.
 */
export function judgeConnectPackets(packets: readonly string[]): HandshakeResult | null {
  for (const packet of packets) {
    if (packet.startsWith("40")) {
      return { ok: false, detail: "Verbindung OHNE Ticket angenommen – Auth-Middleware greift nicht" };
    }
    if (packet.startsWith("44")) {
      try {
        const payload = JSON.parse(packet.slice(2)) as { message?: unknown };
        if (payload.message === "UNAUTHORIZED") return { ok: true, detail: "UNAUTHORIZED" };
        return { ok: false, detail: `abgelehnt mit ${String(payload.message)} statt UNAUTHORIZED` };
      } catch {
        return { ok: false, detail: "CONNECT_ERROR ohne lesbare Nutzlast" };
      }
    }
  }
  return null;
}

/**
 * Socket.IO-Handshake per HTTP-Long-Polling ohne Ticket (roh, damit der `Origin`-Header gesetzt werden
 * kann – der Node-XHR-Transport von socket.io-client verbietet ihn).
 */
export async function pollingHandshake(port: number, origin: string, timeoutMs: number): Promise<HandshakeResult> {
  const base = "/socket.io/?EIO=4&transport=polling";
  const headers = { origin, accept: "*/*" };
  const nonce = () => Math.random().toString(36).slice(2, 10);
  const open = await httpRequest({
    method: "GET",
    host: "127.0.0.1",
    port,
    path: `${base}&t=${nonce()}`,
    headers,
    timeoutMs: 10_000,
  });
  if (open.status !== 200 || !open.body.startsWith("0")) {
    return { ok: false, detail: `kein Engine.IO-Handshake auf /socket.io (HTTP ${open.status})` };
  }
  let sid: string;
  try {
    const parsed = JSON.parse(open.body.slice(1)) as { sid?: unknown };
    if (typeof parsed.sid !== "string") throw new Error("sid fehlt");
    sid = parsed.sid;
  } catch {
    return { ok: false, detail: "Engine.IO-Handshake ohne gültige sid" };
  }
  const sessionPath = `${base}&sid=${encodeURIComponent(sid)}`;
  const connect = await httpRequest({
    method: "POST",
    host: "127.0.0.1",
    port,
    path: `${sessionPath}&t=${nonce()}`,
    headers: { ...headers, "content-type": "text/plain;charset=UTF-8" },
    body: "40",
    timeoutMs: 10_000,
  });
  if (connect.status !== 200) return { ok: false, detail: `CONNECT-Paket abgelehnt (HTTP ${connect.status})` };
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const poll = await httpRequest({
        method: "GET",
        host: "127.0.0.1",
        port,
        path: `${sessionPath}&t=${nonce()}`,
        headers,
        timeoutMs: Math.max(1_000, deadline - Date.now()),
      });
      if (poll.status !== 200) return { ok: false, detail: `Polling-Antwort HTTP ${poll.status}` };
      const verdict = judgeConnectPackets(splitPollingPayload(poll.body));
      if (verdict) return verdict;
    }
    return { ok: false, detail: "keine Antwort auf das CONNECT-Paket" };
  } finally {
    // Sitzung schließen (Paket „1“); Fehler hier sind egal.
    await httpRequest({
      method: "POST",
      host: "127.0.0.1",
      port,
      path: `${sessionPath}&t=${nonce()}`,
      headers: { ...headers, "content-type": "text/plain;charset=UTF-8" },
      body: "1",
      timeoutMs: 3_000,
    }).catch(() => undefined);
  }
}

/** Derselbe Handshake per WebSocket (so verbinden Browser hinter Cloudflare im Normalfall). */
export function websocketHandshake(port: number, origin: string, timeoutMs: number): Promise<HandshakeResult> {
  return new Promise((resolvePromise) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      extraHeaders: { origin },
      reconnection: false,
      forceNew: true,
      timeout: timeoutMs,
      auth: {},
    });
    let settled = false;
    const finish = (result: HandshakeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolvePromise(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, detail: "keine Antwort (Zeitüberschreitung)" }),
      timeoutMs + 1_000,
    );
    socket.on("connect", () =>
      finish({ ok: false, detail: "Verbindung OHNE Ticket angenommen – Auth-Middleware greift nicht" }),
    );
    socket.on("connect_error", (error: Error) => {
      if (error.message === "UNAUTHORIZED") finish({ ok: true, detail: "UNAUTHORIZED" });
      else finish({ ok: false, detail: `abgelehnt mit „${error.message}“ statt UNAUTHORIZED` });
    });
  });
}
