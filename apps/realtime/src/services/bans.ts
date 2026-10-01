/**
 * Sperren (docs/04 bans, docs/06): Prüfung beim Handshake (Gast ODER IP-Schlüssel), Sperren wegen
 * wiederholter Verstöße und Trennen betroffener Sockets. Der Change-Stream-Watcher auf `bans` ruft bei
 * neuen/geänderten Sperren `disconnectBanned()` auf (docs/04: „betroffene Sockets sofort trennen (`kicked`,
 * Grund `abuse`)“).
 *
 * Die Prüfung liest die Datenbank mit Frist; Fehler werden geworfen – der Aufrufer (Handshake) lehnt dann ab
 * (fail-closed).
 */
import type { BansRepo } from "@quizmaster/db";
import type { BanDoc } from "@quizmaster/shared/documents";
import type { AppSocket, Clock } from "../registry/types.ts";
import { withTimeout } from "../registry/util.ts";
import type { ConnectionsService } from "./connections.ts";

/** Frist der Ban-Prüfung im Handshake (unter dem Socket.IO-`connectTimeout` von 10 s). */
export const BAN_LOOKUP_TIMEOUT_MS = 3_000;

export interface BanSubject {
  guestId?: string;
  ipKey?: string | null;
}

export interface BanGuestOptions {
  durationSec: number;
  /** Fester Grund (z. B. „violations“) – nie Client-Daten. */
  reason: string;
}

export interface BansService {
  /** Aktive Sperre für Gast oder IP-Schlüssel; wirft bei DB-Fehler oder Zeitüberschreitung. */
  findActive(subject: BanSubject): Promise<BanDoc | null>;
  /**
   * Sperrt einen Gast befristet (Upsert) und trennt seine Sockets. Eine bestehende längere oder dauerhafte
   * Sperre wird nie verkürzt.
   */
  banGuest(guestId: string, options: BanGuestOptions): Promise<BanDoc>;
  /** Trennt alle Sockets, die eine Sperre betrifft: `kicked { reason: "abuse" }`, dann trennen. Liefert die Anzahl. */
  disconnectBanned(ban: Pick<BanDoc, "kind" | "value">): number;
}

export interface BansServiceOptions {
  repo: BansRepo;
  connections: ConnectionsService;
  clock: Clock;
  lookupTimeoutMs?: number;
}

export function createBansService(options: BansServiceOptions): BansService {
  const lookupTimeoutMs = options.lookupTimeoutMs ?? BAN_LOOKUP_TIMEOUT_MS;

  const disconnectBanned = (ban: Pick<BanDoc, "kind" | "value">): number => {
    const sockets: AppSocket[] =
      ban.kind === "guest" ? options.connections.socketsOfGuest(ban.value) : options.connections.socketsOfIp(ban.value);
    for (const socket of sockets) {
      socket.emit("kicked", { reason: "abuse" });
      socket.disconnect(true);
    }
    return sockets.length;
  };

  return {
    findActive(subject) {
      const now = new Date(options.clock.now());
      const query: { guestId?: string; ipKey?: string } = {};
      if (subject.guestId !== undefined) query.guestId = subject.guestId;
      if (subject.ipKey !== undefined && subject.ipKey !== null) query.ipKey = subject.ipKey;
      return withTimeout(options.repo.findActiveFor(query, now), lookupTimeoutMs, "Ban-Prüfung");
    },

    async banGuest(guestId, ban) {
      const now = options.clock.now();
      const expiresAt = new Date(now + ban.durationSec * 1_000);
      const existing = await options.repo.findActive("guest", guestId, new Date(now));
      const keepExisting =
        existing !== null && (existing.expiresAt === undefined || existing.expiresAt.getTime() >= expiresAt.getTime());
      const doc = keepExisting
        ? existing
        : await options.repo.upsert({ kind: "guest", value: guestId, reason: ban.reason, expiresAt }, new Date(now));
      disconnectBanned(doc);
      return doc;
    },

    disconnectBanned,
  };
}
