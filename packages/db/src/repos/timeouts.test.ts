/**
 * Fristen der spielnahen Zugriffe (CSOT `timeoutMS`): Die Repos geben jedem Hot-Path-Aufruf eine
 * client-seitige Gesamtfrist mit – sonst bricht nur das äußere `withTimeout` der Apps ab, während die
 * Operation im Treiber weiterläuft und eine Pool-Verbindung bis `SOCKET_TIMEOUT_MS` (30 s) belegt.
 * Geprüft über Fake-Collections, die die übergebenen Optionen mitschreiben.
 */
import type { GuestDoc, LobbyDoc, QuestionDoc } from "@quizmaster/shared/documents";
import type { Collection } from "mongodb";
import { describe, expect, it } from "vitest";
import { HOT_PATH_TIMEOUT_MS, POOL_LOAD_TIMEOUT_MS, SOCKET_TIMEOUT_MS } from "../client.ts";
import { createGuestsRepo } from "./guests.ts";
import { activeLobbyExpiresAt, createLobbiesRepo, writeLobbySnapshot } from "./lobbies.ts";
import { createQuestionsRepo } from "./questions.ts";

interface Call {
  method: string;
  options: Record<string, unknown> | undefined;
}

/** Fake-Collection: jede Methode merkt sich ihre Optionen und liefert ein neutrales Ergebnis. */
function fakeCollection<T extends object>(results: { replaceMatched?: number; findOne?: unknown } = {}) {
  const calls: Call[] = [];
  const cursor = {
    toArray: async () => [],
    sort: () => cursor,
    async *[Symbol.asyncIterator]() {},
  };
  const collection = {
    collectionName: "fake",
    find(_filter: unknown, options?: Record<string, unknown>) {
      calls.push({ method: "find", options });
      return cursor;
    },
    async findOne(_filter: unknown, options?: Record<string, unknown>) {
      calls.push({ method: "findOne", options });
      return results.findOne ?? null;
    },
    async insertOne(_doc: unknown, options?: Record<string, unknown>) {
      calls.push({ method: "insertOne", options });
      return { acknowledged: true, insertedId: "x" };
    },
    async replaceOne(_filter: unknown, _doc: unknown, options?: Record<string, unknown>) {
      calls.push({ method: "replaceOne", options });
      return { matchedCount: results.replaceMatched ?? 1, modifiedCount: results.replaceMatched ?? 1 };
    },
    async updateOne(_filter: unknown, _update: unknown, options?: Record<string, unknown>) {
      calls.push({ method: "updateOne", options });
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  return { collection: collection as unknown as Collection<T>, calls };
}

const GUEST_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** Gültiges Lobby-Dokument (wie in repos.test.ts). */
function lobbyDoc(): LobbyDoc {
  const now = new Date("2026-09-30T12:00:00Z");
  return {
    _id: "lobby_timeouts",
    code: "ABC234",
    active: true,
    phase: "lobby",
    rev: 1,
    settings: { rounds: 3, questionsPerCategory: 3, maxPlayers: 8 },
    createdByGuestId: GUEST_ID,
    hostPlayerId: "p1",
    players: [
      {
        playerId: "p1",
        guestId: GUEST_ID,
        name: "Mia",
        color: "blue",
        isBot: false,
        joinedAt: now,
        status: "active",
        score: 0,
      },
    ],
    bannedGuestIds: [],
    game: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: activeLobbyExpiresAt(now),
  };
}

describe("CSOT-Fristen der Hot-Path-Zugriffe", () => {
  it("Fristen liegen unter den äußeren Fristen der Apps und weit unter dem Socket-Timeout", () => {
    expect(HOT_PATH_TIMEOUT_MS).toBeLessThan(5_000);
    expect(POOL_LOAD_TIMEOUT_MS).toBeLessThan(30_000);
    expect(POOL_LOAD_TIMEOUT_MS).toBeLessThanOrEqual(SOCKET_TIMEOUT_MS);
  });

  it("questions: Pool laden und Volldokumente eines Zuges", async () => {
    const { collection, calls } = fakeCollection<QuestionDoc>();
    const repo = createQuestionsRepo(collection);
    await repo.loadPool("all");
    await repo.findForPlay(["co-aaaaaaa1", "co-aaaaaaa2"]);
    expect(calls.map((call) => [call.method, call.options?.timeoutMS])).toEqual([
      ["find", POOL_LOAD_TIMEOUT_MS],
      ["find", HOT_PATH_TIMEOUT_MS],
    ]);
  });

  it("lobbies: Code prüfen, nachschlagen, anlegen, sichern und schließen", async () => {
    const { collection, calls } = fakeCollection<LobbyDoc>();
    const repo = createLobbiesRepo(collection);
    await repo.isCodeTaken("ABC234");
    await repo.findActiveByCode("ABC234");
    expect(await repo.insert(lobbyDoc())).toEqual({ ok: true });
    expect(await repo.save(lobbyDoc())).toBe("saved");
    await repo.close("lobby_timeouts", new Date());
    expect(calls.map((call) => call.method)).toEqual(["findOne", "findOne", "insertOne", "replaceOne", "updateOne"]);
    for (const call of calls) expect(call.options?.timeoutMS, call.method).toBe(HOT_PATH_TIMEOUT_MS);
  });

  it("Snapshot ohne Session: jede Teiloperation mit Frist; in einer Transaktion (Session) ohne eigene Frist", async () => {
    const created = fakeCollection<LobbyDoc>({ replaceMatched: 0, findOne: null });
    expect(await writeLobbySnapshot(created.collection, lobbyDoc())).toBe("saved");
    expect(created.calls.map((call) => [call.method, call.options?.timeoutMS])).toEqual([
      ["replaceOne", HOT_PATH_TIMEOUT_MS],
      ["findOne", HOT_PATH_TIMEOUT_MS],
      ["insertOne", HOT_PATH_TIMEOUT_MS],
    ]);
    const session = { inTransaction: () => true };
    const inTransaction = fakeCollection<LobbyDoc>({ replaceMatched: 1 });
    await writeLobbySnapshot(inTransaction.collection, lobbyDoc(), session as never);
    expect(inTransaction.calls).toEqual([{ method: "replaceOne", options: { session } }]);
  });

  it("guests: anlegen und Aktivität erneuern (Web, POST /api/session und Ticket)", async () => {
    const { collection, calls } = fakeCollection<GuestDoc>();
    const repo = createGuestsRepo(collection);
    await repo.create(GUEST_ID, new Date());
    await repo.touch(GUEST_ID, new Date());
    expect(calls.map((call) => [call.method, call.options?.timeoutMS])).toEqual([
      ["insertOne", HOT_PATH_TIMEOUT_MS],
      ["updateOne", HOT_PATH_TIMEOUT_MS],
    ]);
  });
});
