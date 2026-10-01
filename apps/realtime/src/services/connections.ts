/**
 * Gleichzeitige Verbindungen (docs/06 §Rate-Limits: 5 je Gast · 100 je IP-Schlüssel · MAX_CONNECTIONS global).
 * Der Handshake prüft IP und global vorab (`precheck`, billig in `allowRequest`); verbindlich reserviert wird
 * erst am Ende der Auth-Middleware (`reserve`, synchron → keine Race zwischen parallelen Handshakes). Die
 * Reservierung wird beim Trennen freigegeben – auch, wenn ein Socket nie `connection` erreicht.
 *
 * Nebenbei der Index „Sockets je Gast/IP“ für gezieltes Trennen (Bans) und für die Lobby-Schicht
 * (DISCONNECT erst, wenn der letzte Socket einer Person weg ist).
 */
import { CONNECTION_LIMITS, type ErrorCode } from "@quizmaster/shared";
import type { AppSocket } from "../registry/types.ts";

/** Gemeinsamer Schlüssel für Verbindungen ohne bestimmbare IP (fail-closed: sie teilen sich ein Budget). */
export const UNKNOWN_IP_KEY = "unknown";

export interface ConnectionLimits {
  perGuest: number;
  perIp: number;
  global: number;
}

export type ConnectionLimitName = "guest" | "ip" | "global";

export interface ConnectionRejection {
  code: Extract<ErrorCode, "TOO_MANY_CONNECTIONS" | "SERVER_BUSY">;
  limit: ConnectionLimitName;
}

export interface ConnectionSubject {
  guestId: string;
  ipKey: string | null;
}

export interface ConnectionsService {
  readonly limits: Readonly<ConnectionLimits>;
  total(): number;
  countForGuest(guestId: string): number;
  countForIp(ipKey: string | null): number;
  /** Vorab-Prüfung im Handshake (IP + global), ohne zu reservieren. */
  precheck(ipKey: string | null): ConnectionRejection | null;
  /** Verbindliche Reservierung (Gast, IP, global); `null` = reserviert. */
  reserve(socket: AppSocket, subject: ConnectionSubject): ConnectionRejection | null;
  /** Gibt die Reservierung eines Sockets frei (idempotent). */
  release(socket: AppSocket): void;
  /** Momentaufnahme der Sockets eines Gasts. */
  socketsOfGuest(guestId: string): AppSocket[];
  /** Momentaufnahme der Sockets eines IP-Schlüssels. */
  socketsOfIp(ipKey: string | null): AppSocket[];
  /** Momentaufnahme aller reservierten Sockets. */
  all(): AppSocket[];
}

/** Standardgrenzen: `CONNECTION_LIMITS` × Faktor (relaxed) und `MAX_CONNECTIONS` aus der Env. */
export function connectionLimits(maxConnections: number, factor = 1): ConnectionLimits {
  return {
    perGuest: CONNECTION_LIMITS.perGuest.max * factor,
    perIp: CONNECTION_LIMITS.perIp.max * factor,
    global: maxConnections,
  };
}

interface Reservation {
  guestId: string;
  ipKey: string;
}

export function createConnectionsService(limits: ConnectionLimits): ConnectionsService {
  const byGuest = new Map<string, Set<AppSocket>>();
  const byIp = new Map<string, Set<AppSocket>>();
  const reservations = new Map<AppSocket, Reservation>();

  const add = (index: Map<string, Set<AppSocket>>, key: string, socket: AppSocket) => {
    const set = index.get(key);
    if (set === undefined) index.set(key, new Set([socket]));
    else set.add(socket);
  };
  const remove = (index: Map<string, Set<AppSocket>>, key: string, socket: AppSocket) => {
    const set = index.get(key);
    if (set === undefined) return;
    set.delete(socket);
    if (set.size === 0) index.delete(key);
  };
  const ipBucket = (ipKey: string | null) => ipKey ?? UNKNOWN_IP_KEY;

  const precheck = (ipKey: string | null): ConnectionRejection | null => {
    if (reservations.size >= limits.global) return { code: "SERVER_BUSY", limit: "global" };
    if ((byIp.get(ipBucket(ipKey))?.size ?? 0) >= limits.perIp) return { code: "TOO_MANY_CONNECTIONS", limit: "ip" };
    return null;
  };

  return {
    limits: Object.freeze({ ...limits }),
    total: () => reservations.size,
    countForGuest: (guestId) => byGuest.get(guestId)?.size ?? 0,
    countForIp: (ipKey) => byIp.get(ipBucket(ipKey))?.size ?? 0,
    precheck,
    reserve(socket, subject) {
      if (reservations.has(socket)) return null;
      const rejection = precheck(subject.ipKey);
      if (rejection !== null) return rejection;
      if ((byGuest.get(subject.guestId)?.size ?? 0) >= limits.perGuest) {
        return { code: "TOO_MANY_CONNECTIONS", limit: "guest" };
      }
      const reservation = { guestId: subject.guestId, ipKey: ipBucket(subject.ipKey) };
      reservations.set(socket, reservation);
      add(byGuest, reservation.guestId, socket);
      add(byIp, reservation.ipKey, socket);
      return null;
    },
    release(socket) {
      const reservation = reservations.get(socket);
      if (reservation === undefined) return;
      reservations.delete(socket);
      remove(byGuest, reservation.guestId, socket);
      remove(byIp, reservation.ipKey, socket);
    },
    socketsOfGuest: (guestId) => [...(byGuest.get(guestId) ?? [])],
    socketsOfIp: (ipKey) => [...(byIp.get(ipBucket(ipKey)) ?? [])],
    all: () => [...reservations.keys()],
  };
}
