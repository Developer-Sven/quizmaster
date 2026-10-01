import type { PublicLobbyState } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { testLobby, testPlayer, testQuestion } from "../../lib/client/test-support";
import { ownOutcome, resultHeadline, stageAnnouncement } from "./results";

type Results = NonNullable<PublicLobbyState["results"]>;

const players = [
  testPlayer("p1", { name: "Mia" }),
  testPlayer("p2", { name: "Ben" }),
  testPlayer("p3", { name: "Lea" }),
];

function results(entries: Array<[string, number, number, "active" | "resigned"]>, outcome: "win" | "draw"): Results {
  return {
    outcome,
    ranking: entries.map(([playerId, place, score, status]) => ({ playerId, place, score, status })),
  };
}

describe("Eigenes Ergebnis am Spielende", () => {
  const win = results(
    [
      ["p1", 1, 9, "active"],
      ["p2", 2, 6, "active"],
      ["p3", 3, 2, "resigned"],
    ],
    "win",
  );

  it("unterscheidet gewonnen, verloren (auch aufgegeben) und unentschieden", () => {
    expect(ownOutcome(win, "p1")).toBe("won");
    expect(ownOutcome(win, "p2")).toBe("lost");
    expect(ownOutcome(win, "p3")).toBe("lost");
    expect(ownOutcome(win, "p9")).toBeNull();
    const draw = results(
      [
        ["p1", 1, 5, "active"],
        ["p2", 1, 5, "active"],
      ],
      "draw",
    );
    expect(ownOutcome(draw, "p2")).toBe("draw");
  });

  it("formuliert die Überschrift (docs/09 §11)", () => {
    expect(resultHeadline(win, players, "p1")).toBe("Gewonnen");
    expect(resultHeadline(win, players, "p2")).toBe("Platz 2");
    expect(resultHeadline(win, players, "p3")).toBe("Aufgegeben");
    expect(resultHeadline(win, players, null)).toBe("Mia gewinnt");
  });
});

describe("Ansagen der HUD-Live-Region (docs/09 §7 „Screenreader“)", () => {
  const catalog = { "musik-hits": { id: "musik-hits", name: "Musik & Hits", icon: "music", color: "#5988F8" } };

  it("sagt Kategorie und Frage x/K sowie Richtig/Falsch mit der richtigen Antwort an", () => {
    const question = testQuestion({ index: 2, total: 3 });
    expect(stageAnnouncement(testLobby({ phase: "question", question }), "p1", catalog)).toBe(
      "Musik und Hits. Frage 2 von 3.",
    );
    const resolved = { ...question, correct: 1 as const, picks: { p1: 1 as const, p2: 0 as const } };
    const reveal = testLobby({ phase: "reveal", question: resolved });
    expect(stageAnnouncement(reveal, "p1", catalog)).toBe("Richtig. Plus 1 Punkt.");
    expect(stageAnnouncement(reveal, "p2", catalog)).toBe("Falsch. Richtig war: Canberra.");
  });

  it("sagt am Spielende das eigene Ergebnis an", () => {
    const end = testLobby({
      phase: "game_over",
      order: ["p1", "p2"],
      results: results(
        [
          ["p1", 1, 7, "active"],
          ["p2", 2, 5, "active"],
        ],
        "win",
      ),
    });
    expect(stageAnnouncement(end, "p2", catalog)).toBe("Spiel beendet. Verloren.");
    expect(stageAnnouncement({ ...end, results: null }, "p2", catalog)).toBeNull();
  });
});
