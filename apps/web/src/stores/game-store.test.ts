import { DEFAULT_LOBBY_SETTINGS } from "@quizmaster/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { myChoiceFor } from "../lib/client/game-view";
import { testLobby, testPlayer, testQuestion, testSelf } from "../lib/client/test-support";
import {
  gameActions,
  selectAnnouncement,
  selectConnectionOverlayVisible,
  selectCurrentToast,
  selectPhase,
  selectRulesOpen,
  useGameStore,
} from "./game-store";

const state = () => useGameStore.getState();

beforeEach(() => {
  gameActions.resetAll();
});

describe("rev-Regel (docs/05: kleinere rev verwerfen)", () => {
  it("übernimmt höhere und gleiche rev, verwirft kleinere", () => {
    expect(gameActions.applyPublicState(testLobby({ rev: 5 }))).toBe(true);
    expect(gameActions.applyPublicState(testLobby({ rev: 7, phase: "intro" }))).toBe(true);
    expect(selectPhase(state())).toBe("intro");
    expect(gameActions.applyPublicState(testLobby({ rev: 6, phase: "lobby" }))).toBe(false);
    expect(selectPhase(state())).toBe("intro");
    expect(gameActions.applyPublicState(testLobby({ rev: 7, phase: "category_pick" }))).toBe(true);
    expect(state().lastRev).toBe(7);
  });

  it("nimmt nach einer Wiederaufnahme den nächsten Zustand unabhängig von rev an (z. B. Server-Neustart)", () => {
    gameActions.applyPublicState(testLobby({ rev: 40 }));
    gameActions.beginResync();
    expect(gameActions.applyPublicState(testLobby({ rev: 12, phase: "question" }))).toBe(true);
    expect(state().lastRev).toBe(12);
    expect(gameActions.applyPublicState(testLobby({ rev: 11 }))).toBe(false);
  });

  it("verwirft Zustände einer fremden Lobby, übernimmt den Code ohne Lobby-Kontext", () => {
    gameActions.enterLobby("ABC234");
    expect(gameActions.applyPublicState(testLobby({ code: "XYZ789" }))).toBe(false);
    gameActions.resetLobby();
    expect(gameActions.applyPublicState(testLobby({ code: "XYZ789" }))).toBe(true);
    expect(state().code).toBe("XYZ789");
  });

  it("beginnt beim Wechsel in eine andere Lobby von vorn", () => {
    gameActions.applyPublicState(testLobby({ rev: 50 }));
    gameActions.enterLobby("HJK789");
    expect(state().lobby).toBeNull();
    expect(state().lastRev).toBeNull();
    expect(gameActions.applyPublicState(testLobby({ code: "HJK789", rev: 1 }))).toBe(true);
  });

  it("nimmt nach dem Ende der Lobby (entfernt) nichts mehr an", () => {
    gameActions.applyPublicState(testLobby({ rev: 3 }));
    gameActions.exitLobby({ kind: "kicked", reason: "host" });
    expect(gameActions.applyPublicState(testLobby({ rev: 4 }))).toBe(false);
    expect(state().lobby).toBeNull();
    gameActions.applyPrivateState(testSelf("p1"));
    expect(state().self).toBeNull();
  });
});

describe("optimistische Antwort und Wahl", () => {
  it("behält die getippte Antwort für dieselbe Frage und verwirft sie bei der nächsten", () => {
    gameActions.applyPublicState(testLobby({ rev: 1, phase: "question", question: testQuestion({ id: "q1" }) }));
    gameActions.setPendingAnswer({ questionId: "q1", choice: 2 });
    gameActions.applyPublicState(
      testLobby({ rev: 2, phase: "question", question: testQuestion({ id: "q1", answeredBy: ["p1"] }) }),
    );
    expect(state().pendingAnswer).toEqual({ questionId: "q1", choice: 2 });
    gameActions.applyPublicState(
      testLobby({ rev: 3, phase: "question", question: testQuestion({ id: "q2", index: 2 }) }),
    );
    expect(state().pendingAnswer).toBeNull();
  });

  it("gibt eine unbestätigte Antwort frei, wenn lobby:self sie nicht kennt – mit Hinweis, solange die Frage läuft", () => {
    const question = testQuestion({ id: "q1" });
    gameActions.applyPublicState(testLobby({ rev: 1, phase: "question", question }));
    gameActions.applyPrivateState(testSelf("p1"));
    gameActions.setPendingAnswer({ questionId: "q1", choice: 1 });
    // Kein Ack (NETWORK): ob der Server sie hat, klärt erst der nächste lobby:self (nach resume).
    gameActions.answerUnconfirmed("q1");
    expect(myChoiceFor(question, state().self, state().pendingAnswer)).toBe(1);
    gameActions.applyPrivateState(testSelf("p1", { myAnswer: null }));
    expect(state().pendingAnswer).toBeNull();
    expect(myChoiceFor(question, state().self, state().pendingAnswer)).toBeNull();
    expect(state().toasts.map((toast) => [toast.kind, toast.text])).toEqual([
      ["error", "Deine Antwort kam nicht an. Tippe noch einmal."],
    ]);
  });

  it("behält eine unbestätigte Antwort, die der Server doch bekommen hat", () => {
    const question = testQuestion({ id: "q1" });
    gameActions.applyPublicState(testLobby({ rev: 1, phase: "question", question }));
    gameActions.setPendingAnswer({ questionId: "q1", choice: 3 });
    gameActions.answerUnconfirmed("q1");
    gameActions.applyPrivateState(testSelf("p1", { myAnswer: { questionId: "q1", choice: 3 } }));
    expect(state().pendingAnswer).toEqual({ questionId: "q1", choice: 3, unconfirmed: false });
    expect(myChoiceFor(question, state().self, state().pendingAnswer)).toBe(3);
    // Spätere lobby:self ohne Antwort geben eine bestätigte Antwort nicht mehr frei.
    gameActions.applyPrivateState(testSelf("p1", { myAnswer: null }));
    expect(state().pendingAnswer?.choice).toBe(3);
    expect(state().toasts).toEqual([]);
  });

  it("lässt eine laufende Antwort (Ack ausstehend) trotz lobby:self ohne Antwort eingeloggt", () => {
    gameActions.applyPublicState(testLobby({ rev: 1, phase: "question", question: testQuestion({ id: "q1" }) }));
    gameActions.setPendingAnswer({ questionId: "q1", choice: 0 });
    gameActions.applyPrivateState(testSelf("p1", { myAnswer: null }));
    expect(state().pendingAnswer).toEqual({ questionId: "q1", choice: 0 });
    // Ein verspätetes NETWORK einer anderen Frage ändert nichts.
    gameActions.answerUnconfirmed("q0");
    expect(state().pendingAnswer?.unconfirmed).toBeUndefined();
  });

  it("gibt eine unbestätigte Antwort nach Fristende ohne Hinweis frei (Auflösung zeigt „keine Antwort“)", () => {
    const question = testQuestion({ id: "q1" });
    gameActions.applyPublicState(testLobby({ rev: 1, phase: "question", question }));
    gameActions.setPendingAnswer({ questionId: "q1", choice: 2 });
    gameActions.answerUnconfirmed("q1");
    gameActions.applyPublicState(testLobby({ rev: 2, phase: "reveal", question }));
    gameActions.applyPrivateState(testSelf("p1", { myAnswer: null }));
    expect(state().pendingAnswer).toBeNull();
    expect(state().toasts).toEqual([]);
  });

  it("behält die eigene Wahl nur in derselben Kategoriewahl", () => {
    gameActions.applyPublicState(testLobby({ rev: 1, phase: "category_pick", phaseStartedAt: 5_000 }));
    gameActions.setPendingPick({ phaseStartedAt: 5_000, categoryId: "musik-hits" });
    gameActions.applyPublicState(testLobby({ rev: 2, phase: "category_pick", phaseStartedAt: 5_000 }));
    expect(state().pendingPick?.categoryId).toBe("musik-hits");
    gameActions.applyPublicState(testLobby({ rev: 3, phase: "question", phaseStartedAt: 9_000 }));
    expect(state().pendingPick).toBeNull();
  });
});

describe("Verbindung und Reconnect-Frist", () => {
  it("startet beim Verlust die Frist (Lobby 30 s) und beendet sie bei Erfolg", () => {
    gameActions.applyPublicState(testLobby({ rev: 1 }));
    gameActions.connecting();
    gameActions.connected();
    gameActions.connectionLost(100_000);
    expect(state().connection).toMatchObject({ status: "reconnecting", lostAt: 100_000, graceUntil: 130_000 });
    expect(selectConnectionOverlayVisible(state())).toBe(true);
    // Weitere Fehlversuche verlängern die Frist nicht
    gameActions.connectionLost(104_000);
    expect(state().connection.graceUntil).toBe(130_000);
    gameActions.connected();
    expect(state().connection).toMatchObject({ status: "connected", lostAt: null, graceUntil: null });
    expect(selectConnectionOverlayVisible(state())).toBe(false);
  });

  it("hält den Platz im Spiel 90 s, im fast-Modus 5 s", () => {
    gameActions.applyPublicState(testLobby({ rev: 1, phase: "intro", phaseStartedAt: 0, phaseEndsAt: 4_000 }));
    gameActions.connectionLost(10_000);
    expect(state().connection.graceUntil).toBe(100_000);
    gameActions.connected();
    gameActions.applyPublicState(testLobby({ rev: 2, phase: "intro", phaseStartedAt: 0, phaseEndsAt: 300 }));
    expect(state().timingMode).toBe("fast");
    gameActions.connectionLost(10_000);
    expect(state().connection.graceUntil).toBe(15_000);
  });

  it("zeigt „offline“ sofort und verbindet nach „online“ neu", () => {
    gameActions.applyPublicState(testLobby({ rev: 1 }));
    gameActions.connected();
    gameActions.wentOffline(50_000);
    expect(state().connection).toMatchObject({ status: "offline", lostAt: 50_000, graceUntil: 80_000 });
    gameActions.wentOnline();
    expect(state().connection.status).toBe("reconnecting");
    expect(state().connection.lostAt).toBe(50_000);
  });

  it("zeigt das Overlay schon vor dem ersten Zustand, wenn der erste Verbindungsaufbau scheitert", () => {
    gameActions.enterLobby("ABC234");
    gameActions.connecting();
    expect(selectConnectionOverlayVisible(state())).toBe(false);
    gameActions.connectionLost(2_000);
    expect(selectConnectionOverlayVisible(state())).toBe(true);
    // ohne Lobby-Zustand keine Frist – das Overlay zeigt dann den Lade-Indikator
    expect(state().connection.graceUntil).toBeNull();
  });

  it("zeigt ohne Lobby kein Overlay und bei endgültigen Fehlern stattdessen den Hinweis", () => {
    gameActions.connectionLost(1_000);
    expect(state().connection.graceUntil).toBeNull();
    expect(selectConnectionOverlayVisible(state())).toBe(false);
    gameActions.applyPublicState(testLobby({ rev: 1 }));
    gameActions.connectionFatal("UPDATE_REQUIRED");
    expect(state().updateRequired).toBe(true);
    expect(selectConnectionOverlayVisible(state())).toBe(false);
  });

  it("speichert den Uhren-Offset in ganzen Millisekunden und ignoriert ungültige Werte", () => {
    gameActions.setOffset(7_000.5);
    expect(state().offset).toBe(7_001);
    gameActions.setOffset(Number.NaN);
    expect(state().offset).toBe(7_001);
    gameActions.setOffset(-250.4);
    expect(state().offset).toBe(-250);
  });

  it("zählt Wiederaufnahmen (Timer starten mit Restzeit neu) und merkt vorübergehende Ablehnungen", () => {
    gameActions.resumed();
    gameActions.resumed();
    expect(state().syncGeneration).toBe(2);
    gameActions.connectionRejected("TOO_MANY_CONNECTIONS");
    expect(state().connection.lastError).toBe("TOO_MANY_CONNECTIONS");
    gameActions.connected();
    expect(state().connection.lastError).toBeNull();
  });

  it("vergisst eine gemerkte Ablehnung nur, wenn es genau diese ist", () => {
    gameActions.connectionRejected("TOO_MANY_CONNECTIONS");
    gameActions.clearRejection("TURNSTILE_REQUIRED");
    expect(state().connection.lastError).toBe("TOO_MANY_CONNECTIONS");
    gameActions.connectionRejected("TURNSTILE_REQUIRED");
    gameActions.clearRejection("TURNSTILE_REQUIRED");
    expect(state().connection.lastError).toBeNull();
  });

  it("zeigt die Wartung bis zur nächsten neuen Verbindung", () => {
    gameActions.connected();
    gameActions.applyNotice("MAINTENANCE");
    expect(state().maintenance).toBe(true);
    gameActions.connected();
    expect(state().maintenance).toBe(true);
    gameActions.connectionLost(1);
    gameActions.connected();
    expect(state().maintenance).toBe(false);
  });
});

describe("Hinweise und Kategorien", () => {
  it("erzeugt Toasts für Host-Wechsel und Aufgeben, keine Doppelten hintereinander", () => {
    const players = [testPlayer("p1", { isHost: true, name: "Mia" }), testPlayer("p2", { name: "Ben" })];
    gameActions.applyPublicState(testLobby({ rev: 1, phase: "question", players }));
    gameActions.applyPrivateState(testSelf("p2"));
    gameActions.applyPublicState(
      testLobby({
        rev: 2,
        phase: "question",
        players: [
          testPlayer("p1", { name: "Mia", status: "resigned" }),
          testPlayer("p2", { name: "Ben", isHost: true }),
        ],
      }),
    );
    expect(state().toasts.map((toast) => [toast.kind, toast.text])).toEqual([
      ["hostChanged", "Ben ist jetzt Host."],
      ["playerResigned", "Mia hat aufgegeben."],
    ]);
    const first = selectCurrentToast(state());
    expect(first?.kind).toBe("hostChanged");
    if (first) gameActions.dismissToast(first.id);
    expect(selectCurrentToast(state())?.kind).toBe("playerResigned");

    gameActions.showToast("info", "Code kopiert.");
    gameActions.showToast("info", "Code kopiert.");
    expect(state().toasts.filter((toast) => toast.text === "Code kopiert.")).toHaveLength(1);
    gameActions.applyNotice("SERVER_RESTART");
    expect(state().toasts.at(-1)?.text).toBe("Neustart – gleich geht es weiter.");
  });

  it("Vorschläge (ADR-053): Toast beim Host für neue Vorschläge, bei der Person für die Entscheidung", () => {
    const mia = testPlayer("p1", { isHost: true, name: "Mia" });
    const ben = testPlayer("p2", { name: "Ben" });
    const open = { id: "s1", playerId: "p2", changes: { rounds: 5 }, status: "pending" as const, at: 1 };
    // Sicht des Hosts
    gameActions.applyPublicState(testLobby({ rev: 1, players: [mia, ben] }));
    gameActions.applyPrivateState(testSelf("p1", { isHost: true }));
    gameActions.applyPublicState(testLobby({ rev: 2, players: [mia, ben], suggestions: [open] }));
    expect(state().toasts.at(-1)?.text).toBe("Ben hat einen Vorschlag gemacht.");
    // Sicht von Ben
    gameActions.resetLobby();
    gameActions.applyPublicState(testLobby({ rev: 1, players: [mia, ben], suggestions: [open] }));
    gameActions.applyPrivateState(testSelf("p2", { isHost: false }));
    gameActions.applyPublicState(
      testLobby({ rev: 2, players: [mia, ben], suggestions: [{ ...open, status: "accepted" }] }),
    );
    expect(state().toasts.at(-1)?.text).toBe("Mia hat deinen Vorschlag übernommen.");
  });

  it("Regeln-Sheet (ADR-052): bleibt vom Spielende in die Lobby offen, schließt beim Spielstart und beim Verlassen", () => {
    gameActions.applyPublicState(testLobby({ rev: 1, phase: "game_over", phaseEndsAt: 7_000 }));
    gameActions.openRules();
    expect(selectRulesOpen(state())).toBe(true);
    gameActions.applyPublicState(testLobby({ rev: 2, phase: "lobby", phaseEndsAt: null }));
    expect(selectRulesOpen(state())).toBe(true);
    gameActions.applyPublicState(testLobby({ rev: 3, phase: "intro", phaseEndsAt: 9_000 }));
    expect(selectRulesOpen(state())).toBe(false);
    gameActions.applyPublicState(testLobby({ rev: 4, phase: "lobby", phaseEndsAt: null }));
    gameActions.openRules();
    gameActions.closeRules();
    expect(selectRulesOpen(state())).toBe(false);
    gameActions.openRules();
    gameActions.exitLobby({ kind: "kicked", reason: "host" });
    expect(selectRulesOpen(state())).toBe(false);
  });

  it("Host beendet das Spiel (ADR-051): Hinweis für alle anderen, nicht für den Host selbst", () => {
    gameActions.applyPublicState(testLobby({ rev: 1 }));
    gameActions.applyPrivateState(testSelf("p2", { isHost: false }));
    gameActions.applyNotice("GAME_ENDED");
    expect(state().toasts.at(-1)?.text).toBe("Der Host hat das Spiel beendet.");
    gameActions.resetLobby();
    gameActions.applyPublicState(testLobby({ rev: 1 }));
    gameActions.applyPrivateState(testSelf("p1", { isHost: true }));
    gameActions.applyNotice("GAME_ENDED");
    expect(state().toasts.some((toast) => toast.text === "Der Host hat das Spiel beendet.")).toBe(false);
  });

  it("sagt Beitritte und Austritte in der Lobby an (nur Screenreader, kein Toast)", () => {
    const mia = testPlayer("p1", { isHost: true, name: "Mia" });
    const ben = testPlayer("p2", { name: "Ben" });
    gameActions.applyPublicState(testLobby({ rev: 1, players: [mia] }));
    gameActions.applyPrivateState(testSelf("p1"));
    expect(selectAnnouncement(state())).toBeNull();

    gameActions.applyPublicState(testLobby({ rev: 2, players: [mia, ben] }));
    expect(selectAnnouncement(state())).toBe("Ben ist beigetreten.");
    gameActions.applyPublicState(testLobby({ rev: 3, players: [mia] }));
    expect(selectAnnouncement(state())).toBe("Ben hat die Lobby verlassen.");
    // Zweimal hintereinander derselbe Text (zweiter Bot gleichen Namens): Er muss sich unterscheiden, sonst
    // schwiege die Live-Region beim zweiten Mal.
    const bot = testPlayer("p3", { name: "Bot", isBot: true });
    const botTwin = testPlayer("p4", { name: "Bot", isBot: true });
    gameActions.applyPublicState(testLobby({ rev: 4, players: [mia, bot] }));
    expect(selectAnnouncement(state())).toBe("Bot ist beigetreten.");
    gameActions.applyPublicState(testLobby({ rev: 5, players: [mia, bot, botTwin] }));
    expect(selectAnnouncement(state())).toBe("Bot ist beigetreten.\u00a0");
    gameActions.applyPublicState(testLobby({ rev: 6, players: [mia] }));
    expect(selectAnnouncement(state())).toBe("Bot hat die Lobby verlassen. Bot hat die Lobby verlassen.");
    expect(state().toasts).toEqual([]);

    // Ein Zustand ohne Änderung der Liste lässt die letzte Ansage stehen; das Verlassen der Lobby löscht sie.
    const settings = { ...DEFAULT_LOBBY_SETTINGS, rounds: 4 };
    gameActions.applyPublicState(testLobby({ rev: 7, players: [mia], settings }));
    expect(selectAnnouncement(state())).toBe("Bot hat die Lobby verlassen. Bot hat die Lobby verlassen.");
    gameActions.resetLobby();
    expect(selectAnnouncement(state())).toBeNull();
  });

  it("merkt sich die Kategorien aus den Zug-Optionen", () => {
    const music = { id: "musik-hits", name: "Musik & Hits", icon: "music", color: "#5988F8" };
    const books = { id: "buecher-woerter", name: "Bücher & Wörter", icon: "book-open", color: "#EBB447" };
    const world = { id: "rund-um-die-welt", name: "Rund um die Welt", icon: "globe", color: "#3F9FF3" };
    gameActions.applyPublicState(
      testLobby({
        rev: 1,
        phase: "category_pick",
        turn: { pickerId: "p1", options: [music, books, world], categoryId: null },
      }),
    );
    expect(Object.keys(state().categories)).toEqual([music.id, books.id, world.id]);
    gameActions.addCategories([{ id: "comics", name: "Comics", icon: "message-circle", color: "#F7DF45" }]);
    expect(state().categories.comics?.name).toBe("Comics");
  });
});
