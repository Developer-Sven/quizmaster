/** Verbindungsgrenzen je Gast, IP-Schlüssel und global (docs/06) – Reservierung, Freigabe, Index. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AppSocket } from "../../src/registry/types.ts";
import { connectionLimits, createConnectionsService, UNKNOWN_IP_KEY } from "../../src/services/connections.ts";

const fakeSocket = () => ({ id: randomUUID() }) as unknown as AppSocket;

describe("Verbindungen", () => {
  it("Standardgrenzen: 5 je Gast, 100 je IP, global aus MAX_CONNECTIONS; relaxed × Faktor", () => {
    expect(connectionLimits(20_000)).toEqual({ perGuest: 5, perIp: 100, global: 20_000 });
    expect(connectionLimits(20_000, 100)).toEqual({ perGuest: 500, perIp: 10_000, global: 20_000 });
  });

  it("je Gast höchstens perGuest Sockets", () => {
    const connections = createConnectionsService({ perGuest: 2, perIp: 10, global: 10 });
    const guestId = randomUUID();
    const sockets = [fakeSocket(), fakeSocket(), fakeSocket()];
    expect(connections.reserve(sockets[0] as AppSocket, { guestId, ipKey: "a" })).toBeNull();
    expect(connections.reserve(sockets[1] as AppSocket, { guestId, ipKey: "b" })).toBeNull();
    expect(connections.reserve(sockets[2] as AppSocket, { guestId, ipKey: "c" })).toEqual({
      code: "TOO_MANY_CONNECTIONS",
      limit: "guest",
    });
    expect(connections.countForGuest(guestId)).toBe(2);
    connections.release(sockets[0] as AppSocket);
    connections.release(sockets[0] as AppSocket);
    expect(connections.countForGuest(guestId)).toBe(1);
    expect(connections.reserve(sockets[2] as AppSocket, { guestId, ipKey: "c" })).toBeNull();
    expect(connections.socketsOfGuest(guestId)).toEqual([sockets[1], sockets[2]]);
  });

  it("je IP-Schlüssel höchstens perIp Sockets; unbekannte IPs teilen sich einen Schlüssel", () => {
    const connections = createConnectionsService({ perGuest: 10, perIp: 2, global: 10 });
    for (let i = 0; i < 2; i++) {
      expect(connections.reserve(fakeSocket(), { guestId: randomUUID(), ipKey: "ip-1" })).toBeNull();
      expect(connections.reserve(fakeSocket(), { guestId: randomUUID(), ipKey: null })).toBeNull();
    }
    expect(connections.precheck("ip-1")).toEqual({ code: "TOO_MANY_CONNECTIONS", limit: "ip" });
    expect(connections.reserve(fakeSocket(), { guestId: randomUUID(), ipKey: "ip-1" })?.limit).toBe("ip");
    expect(connections.reserve(fakeSocket(), { guestId: randomUUID(), ipKey: null })?.limit).toBe("ip");
    expect(connections.countForIp(null)).toBe(2);
    expect(connections.countForIp(UNKNOWN_IP_KEY)).toBe(2);
    expect(connections.precheck("ip-2")).toBeNull();
  });

  it("global höchstens MAX_CONNECTIONS → SERVER_BUSY", () => {
    const connections = createConnectionsService({ perGuest: 10, perIp: 10, global: 2 });
    const first = fakeSocket();
    expect(connections.reserve(first, { guestId: randomUUID(), ipKey: "a" })).toBeNull();
    expect(connections.reserve(fakeSocket(), { guestId: randomUUID(), ipKey: "b" })).toBeNull();
    expect(connections.precheck("c")).toEqual({ code: "SERVER_BUSY", limit: "global" });
    expect(connections.reserve(fakeSocket(), { guestId: randomUUID(), ipKey: "c" })).toEqual({
      code: "SERVER_BUSY",
      limit: "global",
    });
    expect(connections.total()).toBe(2);
    connections.release(first);
    expect(connections.total()).toBe(1);
    expect(connections.all()).toHaveLength(1);
  });

  it("doppelte Reservierung desselben Sockets zählt einmal", () => {
    const connections = createConnectionsService({ perGuest: 5, perIp: 5, global: 5 });
    const socket = fakeSocket();
    const guestId = randomUUID();
    expect(connections.reserve(socket, { guestId, ipKey: "a" })).toBeNull();
    expect(connections.reserve(socket, { guestId, ipKey: "a" })).toBeNull();
    expect(connections.total()).toBe(1);
    expect(connections.socketsOfIp("a")).toEqual([socket]);
  });
});
