import { describe, expect, it } from "vitest";
import {
  announcementFor,
  answerWaitingCount,
  categoryVisual,
  connectedCount,
  currentTurnRow,
  duelOutcome,
  duelSides,
  firstRowOfRound,
  gameParticipants,
  lobbyNotices,
  lobbyRosterChanges,
  mergeCategories,
  missedAnswer,
  missingCategoryIds,
  myChoiceFor,
  pickersByAnswer,
  placesFor,
  playersSelfFirst,
  questionAnswerStates,
  rankChanges,
  revealAnswerStates,
  reviewSheetOpen,
  summarizeTurn,
} from "./game-view";
import { testLobby, testPlayer, testQuestion, testRow, testSelf } from "./test-support";

const MUSIC = { id: "musik-hits", name: "Musik & Hits", icon: "music", color: "#5988F8" };
const BOOKS = { id: "buecher-woerter", name: "Bücher & Wörter", icon: "book-open", color: "#EBB447" };
const CATALOG = { [MUSIC.id]: MUSIC, [BOOKS.id]: BOOKS };

describe("Personen", () => {
  const players = [testPlayer("p1"), testPlayer("p2"), testPlayer("p3", { connected: false })];

  it("stellt die eigene Person an den Anfang (Spielerstreifen)", () => {
    expect(playersSelfFirst(players, "p3").map((player) => player.id)).toEqual(["p3", "p1", "p2"]);
    expect(playersSelfFirst(players, null).map((player) => player.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("zählt verbundene Personen (Start ab 2)", () => {
    expect(connectedCount(players)).toBe(2);
  });

  it("liefert die Personen des Spiels in Wahl-Reihenfolge", () => {
    const lobby = testLobby({ players, order: ["p3", "p1"] });
    expect(gameParticipants(lobby).map((player) => player.id)).toEqual(["p3", "p1"]);
    expect(gameParticipants(testLobby({ players })).map((player) => player.id)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("Frage", () => {
  it("wartet nur auf verbundene aktive Personen ohne Antwort (ohne sich selbst)", () => {
    const lobby = testLobby({
      players: [
        testPlayer("p1"),
        testPlayer("p2"),
        testPlayer("p3", { connected: false }),
        testPlayer("p4", { status: "resigned" }),
        testPlayer("p5"),
      ],
      question: testQuestion({ answeredBy: ["p2"] }),
    });
    expect(answerWaitingCount(lobby, "p1")).toBe(1);
    expect(answerWaitingCount(lobby, null)).toBe(2);
  });

  it("nimmt die bestätigte Antwort vor der optimistischen, nur für dieselbe Frage", () => {
    const question = testQuestion({ id: "q7" });
    expect(myChoiceFor(question, testSelf("p1", { myAnswer: { questionId: "q7", choice: 2 } }), null)).toBe(2);
    expect(myChoiceFor(question, testSelf("p1"), { questionId: "q7", choice: 3 })).toBe(3);
    expect(myChoiceFor(question, testSelf("p1"), { questionId: "q6", choice: 3 })).toBeNull();
    expect(myChoiceFor(null, testSelf("p1"), { questionId: "q7", choice: 3 })).toBeNull();
  });

  it("loggt ein: gewählte Antwort locked, übrige dimmed; ohne Recht nicht bedienbar", () => {
    expect(questionAnswerStates(null, true)).toEqual(["idle", "idle", "idle", "idle"]);
    expect(questionAnswerStates(2, true)).toEqual(["dimmed", "dimmed", "locked", "dimmed"]);
    expect(questionAnswerStates(null, false)).toEqual(["disabled", "disabled", "disabled", "disabled"]);
  });

  it("löst auf: richtig grün, eigene falsche rot, übrige gedimmt", () => {
    expect(revealAnswerStates(1, 1)).toEqual(["dimmed", "correct", "dimmed", "dimmed"]);
    expect(revealAnswerStates(1, 3)).toEqual(["dimmed", "correct", "dimmed", "wrong"]);
    expect(revealAnswerStates(0, null)).toEqual(["correct", "dimmed", "dimmed", "dimmed"]);
  });

  it("zeigt je Antwort, wer sie gewählt hat, und erkennt „Zeit abgelaufen“", () => {
    const players = [testPlayer("p1", { name: "Mia" }), testPlayer("p2", { name: "Ben", color: "sky" })];
    const pickers = pickersByAnswer({ p1: 2, p2: 2 }, players);
    expect(pickers[2]?.map((picker) => picker.name)).toEqual(["Mia", "Ben"]);
    expect(pickers[0]).toEqual([]);
    expect(missedAnswer({ p1: null, p2: 1 }, "p1")).toBe(true);
    expect(missedAnswer({ p2: 1 }, "p1")).toBe(false); // nicht beteiligt
    expect(missedAnswer({ p1: 0 }, "p1")).toBe(false);
  });
});

describe("Zug-Ergebnis und Tafel", () => {
  it("sortiert nach Punkten des Zuges und markiert die Besten", () => {
    const summary = summarizeTurn(
      testRow(1, "p1", { p1: [true, false, true], p2: [true, true, true], p3: [null, false, false] }),
    );
    expect(summary.entries.map((entry) => [entry.playerId, entry.points])).toEqual([
      ["p2", 3],
      ["p1", 2],
      ["p3", 0],
    ]);
    expect(summary.bestPlayerIds).toEqual(["p2"]);
    expect(summarizeTurn(testRow(1, "p1", { p1: [false], p2: [null] })).bestPlayerIds).toEqual([]);
    expect(summarizeTurn(testRow(1, "p1", { p1: [true], p2: [true] })).bestPlayerIds).toEqual(["p1", "p2"]);
  });

  it("findet die Tafelzeile des aktuellen Zuges", () => {
    const board = [
      testRow(1, "p1", {}, "musik-hits"),
      testRow(1, "p2", {}, "buecher-woerter"),
      testRow(2, "p1", {}, "musik-hits"),
    ];
    const lobby = testLobby({
      board,
      turn: { pickerId: "p2", options: [MUSIC, BOOKS, MUSIC], categoryId: "buecher-woerter" },
      progress: { round: 1, rounds: 3, turn: 2, turnsPerRound: 2 },
    });
    expect(currentTurnRow(lobby)).toBe(board[1]);
    expect(firstRowOfRound(board, 2)).toBe(2);
    expect(firstRowOfRound(board, 3)).toBe(3);
  });

  it("vergibt Plätze mit Gleichstand und setzt Aufgegebene ans Ende", () => {
    const places = placesFor([
      { playerId: "a", status: "active", score: 5 },
      { playerId: "b", status: "active", score: 7 },
      { playerId: "c", status: "active", score: 5 },
      { playerId: "d", status: "resigned", score: 9 },
    ]);
    expect(Object.fromEntries(places)).toEqual({ b: 1, a: 2, c: 2, d: 4 });
  });

  it("zeigt Platzwechsel gegenüber der Vorrunde", () => {
    const players = [testPlayer("p1"), testPlayer("p2")];
    const board = [
      testRow(1, "p1", { p1: [true, true], p2: [false, false] }),
      testRow(2, "p2", { p1: [false, false], p2: [true, true] }),
      testRow(2, "p1", { p1: [false], p2: [true] }),
    ];
    expect(rankChanges(board, players, 1)).toEqual({ p1: null, p2: null });
    expect(rankChanges(board, players, 2)).toEqual({ p1: "down", p2: "up" });
  });
});

describe("Spielende", () => {
  const players = [testPlayer("p1", { name: "Mia" }), testPlayer("p2", { name: "Ben" })];

  it("stellt im Duell die eigene Person links dar", () => {
    expect(duelSides(players, "p2")?.map((player) => player.id)).toEqual(["p2", "p1"]);
    expect(duelSides(players, "p1")?.map((player) => player.id)).toEqual(["p1", "p2"]);
    expect(duelSides([...players, testPlayer("p3")], "p1")).toBeNull();
  });

  it("liefert Gewonnen/Verloren/Unentschieden aus eigener Sicht", () => {
    const win = {
      outcome: "win" as const,
      ranking: [
        { playerId: "p1", place: 1, score: 7, status: "active" as const },
        { playerId: "p2", place: 2, score: 5, status: "active" as const },
      ],
    };
    expect(duelOutcome(win, "p1")).toBe("won");
    expect(duelOutcome(win, "p2")).toBe("lost");
    expect(duelOutcome(win, "p9")).toBeNull();
    const draw = {
      outcome: "draw" as const,
      ranking: [
        { playerId: "p1", place: 1, score: 5, status: "active" as const },
        { playerId: "p2", place: 1, score: 5, status: "active" as const },
      ],
    };
    expect(duelOutcome(draw, "p2")).toBe("draw");
    const resigned = {
      outcome: "win" as const,
      ranking: [
        { playerId: "p2", place: 1, score: 1, status: "active" as const },
        { playerId: "p1", place: 2, score: 9, status: "resigned" as const },
      ],
    };
    expect(duelOutcome(resigned, "p1")).toBe("lost");
  });

  it("„Fragen ansehen“ gehört zu genau einem Spielende – nach einer Revanche öffnet es sich nicht von selbst", () => {
    const firstGameOver = testLobby({ phase: "game_over", phaseStartedAt: 50_000 });
    expect(reviewSheetOpen(null, firstGameOver)).toBe(false);
    expect(reviewSheetOpen(50_000, firstGameOver)).toBe(true);
    // Revanche: neues Spiel läuft – das Sheet ist zu …
    expect(reviewSheetOpen(50_000, testLobby({ phase: "intro", phaseStartedAt: 60_000 }))).toBe(false);
    // … und bleibt es auch beim nächsten Spielende, obwohl es beim ersten offen war.
    expect(reviewSheetOpen(50_000, testLobby({ phase: "game_over", phaseStartedAt: 90_000 }))).toBe(false);
  });
});

describe("Ansagen (docs/09 §7 Screenreader)", () => {
  const players = [testPlayer("p1", { name: "Mia" }), testPlayer("p2", { name: "Ben" })];
  const progress = { round: 2, rounds: 3, turn: 1, turnsPerRound: 2 };

  it("sagt die Kategoriewahl an – für sich selbst als Aufforderung", () => {
    const lobby = testLobby({
      phase: "category_pick",
      players,
      progress,
      turn: { pickerId: "p2", options: [MUSIC, BOOKS, MUSIC], categoryId: null },
    });
    expect(announcementFor(lobby, "p1", CATALOG)).toBe("Runde 2 von 3. Ben wählt eine Kategorie.");
    expect(announcementFor(lobby, "p2", CATALOG)).toBe("Runde 2 von 3. Wähle eine Kategorie.");
  });

  it("sagt Kategorie und Frage an", () => {
    const lobby = testLobby({ phase: "question", players, question: testQuestion({ categoryId: BOOKS.id, index: 2 }) });
    expect(announcementFor(lobby, "p1", CATALOG)).toBe("Bücher und Wörter. Frage 2 von 3.");
  });

  it("sagt richtig/falsch nur für Teilnehmende an", () => {
    const reveal = (own: 0 | 1 | null) =>
      testLobby({
        phase: "reveal",
        players,
        question: testQuestion({ correct: 1, picks: { p1: own, p2: 1 }, explanation: null }),
      });
    expect(announcementFor(reveal(1), "p1", CATALOG)).toBe("Richtig. Plus 1 Punkt.");
    expect(announcementFor(reveal(0), "p1", CATALOG)).toBe("Falsch. Richtig war: Canberra.");
    expect(announcementFor(reveal(null), "p1", CATALOG)).toBe("Falsch. Richtig war: Canberra.");
    expect(announcementFor(reveal(1), "p9", CATALOG)).toBeNull();
  });

  it("sagt am Rundenende den eigenen Platz an", () => {
    const lobby = testLobby({
      phase: "round_board",
      players,
      order: ["p1", "p2"],
      progress: { round: 1, rounds: 3, turn: 2, turnsPerRound: 2 },
      board: [testRow(1, "p1", { p1: [true], p2: [true, true] })],
    });
    expect(announcementFor(lobby, "p1", CATALOG)).toBe("Runde 1 beendet. Du bist auf Platz 2.");
  });
});

describe("Hinweise aus dem Zustandsvergleich", () => {
  const base = testLobby({
    phase: "question",
    players: [
      testPlayer("p1", { isHost: true, name: "Mia" }),
      testPlayer("p2", { name: "Ben" }),
      testPlayer("p3", { name: "Lea" }),
    ],
  });

  it("meldet Host-Wechsel und Aufgeben im laufenden Spiel", () => {
    const next = testLobby({
      phase: "question",
      players: [
        testPlayer("p1", { name: "Mia", status: "resigned" }),
        testPlayer("p2", { name: "Ben", isHost: true }),
        testPlayer("p3", { name: "Lea" }),
      ],
    });
    expect(lobbyNotices(base, next, "p3")).toEqual([
      { kind: "hostChanged", name: "Ben" },
      { kind: "playerResigned", name: "Mia" },
    ]);
  });

  it("meldet weder die eigene Aufgabe noch Hinweise ohne Vorzustand oder fremde Lobby", () => {
    const next = testLobby({
      phase: "question",
      players: [
        testPlayer("p1", { isHost: true, name: "Mia", status: "resigned" }),
        testPlayer("p2"),
        testPlayer("p3"),
      ],
    });
    expect(lobbyNotices(base, next, "p1")).toEqual([]);
    expect(lobbyNotices(null, next, "p2")).toEqual([]);
    expect(lobbyNotices({ ...base, code: "XYZ789" }, next, "p2")).toEqual([]);
  });
});

describe("Beitritte und Austritte in der Lobby (Ansage, WCAG 4.1.3)", () => {
  const mia = testPlayer("p1", { isHost: true, name: "Mia" });
  const lobby = testLobby({ players: [mia, testPlayer("p2", { name: "Ben" })] });

  it("meldet, wer dazukommt und wer geht – nie die eigene Person", () => {
    const joined = testLobby({ players: [...lobby.players, testPlayer("p3", { name: "Lea" })] });
    expect(lobbyRosterChanges(lobby, joined, "p1")).toEqual({ joined: ["Lea"], left: [] });
    const left = testLobby({ players: [mia] });
    expect(lobbyRosterChanges(lobby, left, "p1")).toEqual({ joined: [], left: ["Ben"] });
    expect(lobbyRosterChanges(left, lobby, "p2")).toEqual({ joined: [], left: [] });
  });

  it("schweigt ohne Vorzustand, in fremder Lobby, außerhalb der Lobby-Phase und bei bloßer Trennung", () => {
    const joined = testLobby({ players: [...lobby.players, testPlayer("p3", { name: "Lea" })] });
    expect(lobbyRosterChanges(null, joined, "p1")).toEqual({ joined: [], left: [] });
    expect(lobbyRosterChanges({ ...lobby, code: "XYZ789" }, joined, "p1")).toEqual({ joined: [], left: [] });
    // Revanche (game_over → lobby) und laufendes Spiel: keine Beitritts-Ansagen
    expect(lobbyRosterChanges({ ...lobby, phase: "game_over" }, joined, "p1")).toEqual({ joined: [], left: [] });
    expect(lobbyRosterChanges(lobby, { ...joined, phase: "intro" }, "p1")).toEqual({ joined: [], left: [] });
    // getrennt ist nicht gegangen (die Person bleibt in der Liste, „offline“)
    const offline = testLobby({ players: [mia, testPlayer("p2", { name: "Ben", connected: false })] });
    expect(lobbyRosterChanges(lobby, offline, "p1")).toEqual({ joined: [], left: [] });
  });
});

describe("Kategorien", () => {
  it("liefert Darstellung oder neutralen Platzhalter", () => {
    expect(categoryVisual(CATALOG, MUSIC.id)).toEqual({ name: MUSIC.name, icon: MUSIC.icon, color: MUSIC.color });
    expect(categoryVisual(CATALOG, "unbekannt")).toEqual({ name: "Kategorie", icon: "", color: "" });
  });

  it("merkt neue Optionen und behält den Katalog, wenn nichts neu ist", () => {
    const merged = mergeCategories({}, [MUSIC, BOOKS]);
    expect(Object.keys(merged)).toEqual([MUSIC.id, BOOKS.id]);
    expect(mergeCategories(merged, [MUSIC])).toBe(merged);
  });

  it("findet Kategorien der Tafel ohne Darstellung", () => {
    const lobby = testLobby({ board: [testRow(1, "p1", {}, "comics"), testRow(1, "p2", {}, MUSIC.id)] });
    expect(missingCategoryIds(lobby, CATALOG)).toEqual(["comics"]);
    expect(missingCategoryIds(null, CATALOG)).toEqual([]);
  });
});
