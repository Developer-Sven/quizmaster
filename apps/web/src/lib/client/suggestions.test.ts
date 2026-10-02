import type { SettingsSuggestion } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { ownPendingSuggestion, pendingSuggestions, suggestionNotices } from "./suggestions";
import { testLobby, testPlayer } from "./test-support";

const mia = testPlayer("p1", { isHost: true, name: "Mia" });
const ben = testPlayer("p2", { name: "Ben" });
const lea = testPlayer("p3", { name: "Lea" });

function suggestion(
  id: string,
  playerId: string,
  status: SettingsSuggestion["status"] = "pending",
): SettingsSuggestion {
  return { id, playerId, changes: { rounds: 5 }, status, at: 1 };
}

function lobby(rev: number, suggestions: SettingsSuggestion[], allowSuggestions = true) {
  const base = testLobby();
  return testLobby({
    rev,
    players: [mia, ben, lea],
    settings: { ...base.settings, allowSuggestions },
    suggestions,
  });
}

describe("Vorschläge im Client (ADR-053)", () => {
  it("offene Vorschläge und der eigene offene Vorschlag", () => {
    const state = lobby(1, [suggestion("s1", "p2", "accepted"), suggestion("s2", "p3")]);
    expect(pendingSuggestions(state).map((entry) => entry.id)).toEqual(["s2"]);
    expect(ownPendingSuggestion(state, "p3")?.id).toBe("s2");
    expect(ownPendingSuggestion(state, "p2")).toBeNull();
    expect(ownPendingSuggestion(state, null)).toBeNull();
  });

  it("der Host erfährt jeden neuen Vorschlag – auch einen ersetzten –, aber nicht die schon bekannten", () => {
    const before = lobby(1, [suggestion("s1", "p2")]);
    const after = lobby(2, [suggestion("s1", "p2"), suggestion("s2", "p3")]);
    expect(suggestionNotices(before, after, "p1")).toEqual([{ kind: "suggestionReceived", name: "Lea" }]);
    expect(suggestionNotices(after, lobby(3, [suggestion("s3", "p2"), suggestion("s2", "p3")]), "p1")).toEqual([
      { kind: "suggestionReceived", name: "Ben" },
    ]);
    // Erster Zustand bzw. andere Lobby: nichts ansagen.
    expect(suggestionNotices(null, after, "p1")).toEqual([]);
    expect(suggestionNotices({ ...before, code: "XYZ234" }, after, "p1")).toEqual([]);
  });

  it("die Person erfährt Übernahme, Ablehnung und „Vorschläge aus“ – Zurückziehen bleibt still", () => {
    const open = lobby(1, [suggestion("s1", "p2")]);
    expect(suggestionNotices(open, lobby(2, [suggestion("s1", "p2", "accepted")]), "p2")).toEqual([
      { kind: "suggestionAccepted", host: "Mia" },
    ]);
    expect(suggestionNotices(open, lobby(2, [suggestion("s1", "p2", "declined")]), "p2")).toEqual([
      { kind: "suggestionDeclined", host: "Mia" },
    ]);
    expect(suggestionNotices(open, lobby(2, [], false), "p2")).toEqual([{ kind: "suggestionsOff" }]);
    expect(suggestionNotices(open, lobby(2, []), "p2")).toEqual([]);
    // Fremde Vorschläge gehen die Person nichts an.
    expect(suggestionNotices(open, lobby(2, [suggestion("s1", "p2", "declined")]), "p3")).toEqual([]);
  });
});
