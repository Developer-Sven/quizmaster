import { describe, expect, it } from "vitest";
import { judgeConnectPackets, parseSsListeners, splitPollingPayload } from "./net.ts";

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
