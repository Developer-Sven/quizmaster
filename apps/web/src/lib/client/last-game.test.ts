import type { PublicLobbyState } from "@quizmaster/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LastGameSnapshot, loadLastGame, nextLastGame, saveLastGame } from "./last-game";
import { testLobby, testPlayer } from "./test-support";

const RESULTS: NonNullable<PublicLobbyState["results"]> = {
  outcome: "win",
  ranking: [
    { playerId: "p1", place: 1, score: 3, status: "active" },
    { playerId: "p2", place: 2, score: 1, status: "active" },
  ],
};

function gameOver(patch: Partial<PublicLobbyState> = {}): PublicLobbyState {
  return testLobby({
    phase: "game_over",
    phaseStartedAt: 50_000,
    phaseEndsAt: 55_000,
    order: ["p1", "p2"],
    results: RESULTS,
    ...patch,
  });
}

/** sessionStorage-Ersatz (Node-Testumgebung ohne DOM). */
function stubSessionStorage(): Map<string, string> {
  const data = new Map<string, string>();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  });
  return data;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("nextLastGame (ADR-038)", () => {
  it("merkt sich das Spielende samt Personen; eigene playerId nur bei Teilnahme", () => {
    const over = gameOver();
    const played = nextLastGame(null, over, "p2");
    expect(played).toEqual({ code: "ABC234", state: over, selfId: "p2" });
    expect(nextLastGame(null, over, "p9")?.selfId).toBeNull();
    expect(nextLastGame(null, over, null)?.selfId).toBeNull();
  });

  it("bleibt in der Lobby derselben Lobby erhalten, fällt bei neuem Spiel oder anderer Lobby weg", () => {
    const snapshot = nextLastGame(null, gameOver(), "p1");
    const lobby = testLobby({ players: [testPlayer("p1", { isHost: true }), testPlayer("p3")] });
    expect(nextLastGame(snapshot, lobby, "p1")).toBe(snapshot);
    expect(nextLastGame(snapshot, testLobby({ code: "XYZ789" }), "p1")).toBeNull();
    expect(nextLastGame(snapshot, testLobby({ phase: "intro" }), "p1")).toBeNull();
    expect(nextLastGame(null, testLobby(), "p1")).toBeNull();
  });
});

describe("saveLastGame / loadLastGame", () => {
  it("überlebt ein Neuladen im Tab (sessionStorage) und gilt nur für dieselbe Lobby", () => {
    const data = stubSessionStorage();
    const snapshot = nextLastGame(null, gameOver(), "p1") as LastGameSnapshot;
    saveLastGame(snapshot);
    expect(data.size).toBe(1);
    expect(loadLastGame("ABC234")).toEqual(snapshot);
    expect(loadLastGame("XYZ789")).toBeNull();
    saveLastGame(null);
    expect(loadLastGame("ABC234")).toBeNull();
  });

  it("verwirft Kaputtes und Fremdes ohne Fehler", () => {
    const data = stubSessionStorage();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    data.set("qm.lastGame", "{kein json");
    expect(loadLastGame("ABC234")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    data.set("qm.lastGame", JSON.stringify({ code: "ABC234", state: testLobby(), selfId: "p1" }));
    expect(loadLastGame("ABC234")).toBeNull();
    data.set("qm.lastGame", JSON.stringify({ code: "ABC234", state: { phase: "game_over" }, selfId: "p1" }));
    expect(loadLastGame("ABC234")).toBeNull();
  });

  it("ohne Speicher (Server, privater Modus) einfach nichts", () => {
    expect(loadLastGame("ABC234")).toBeNull();
    expect(() => saveLastGame(null)).not.toThrow();
  });
});
