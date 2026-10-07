import { ERROR_CODES, REPORT_REASONS } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { de, errorMessage, errorPresentation, errorPresentations, kickedMessage, spokenCategoryName } from "./de";

/** Fehlercodes aus docs/05 „Fehlercodes“. */
const PROTOCOL_ERROR_CODES = [
  "VALIDATION_FAILED",
  "UNAUTHORIZED",
  "UPDATE_REQUIRED",
  "RATE_LIMITED",
  "TOO_MANY_CONNECTIONS",
  "SERVER_BUSY",
  "LOBBY_NOT_FOUND",
  "LOBBY_FULL",
  "GAME_IN_PROGRESS",
  "NOT_HOST",
  "NOT_YOUR_TURN",
  "INVALID_OPTION",
  "INVALID_PHASE",
  "ALREADY_ANSWERED",
  "TOO_EARLY",
  "TOO_LATE",
  "NAME_REJECTED",
  "NOT_ENOUGH_PLAYERS",
  "KICKED",
  "BANNED",
  "RESIGNED",
  "LOBBY_CREATION_DISABLED",
  "TURNSTILE_REQUIRED",
  "INTERNAL",
];

/** Beispielargumente für Funktionen, deren Parameter keine einfachen Texte sind. */
const SPECIAL_ARGS: Record<string, unknown[]> = {
  // Kategorien der Reihe nach (ADR-056): Liste von Namen
  "de.lobby.categorySequence": [["Sport", "Musik"]],
  "de.a11y.pickedBy": [["Mia", "Ben"]],
};

/** Alle Texte: Strings direkt, Funktionen mit Beispielwerten (Namen und Zahlen als Text) ausgewertet. */
function collectTexts(value: unknown, path = "de"): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  if (typeof value === "function") {
    const special = SPECIAL_ARGS[path];
    const samples = special ? [special] : [Array(value.length).fill("Mia"), Array(value.length).fill("2")];
    return samples.map((args, index) => {
      const result: unknown = value(...args);
      expect(typeof result, path).toBe("string");
      return [`${path}(${index})`, String(result)] as [string, string];
    });
  }
  if (Array.isArray(value)) return value.flatMap((entry, index) => collectTexts(entry, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => collectTexts(entry, `${path}.${key}`));
  }
  return [];
}

function allTexts(): Array<[string, string]> {
  return [
    ...collectTexts(de),
    ...Object.entries(errorPresentations).flatMap(([code, presentation]) =>
      collectTexts(presentation, `errors.${code}`),
    ),
  ];
}

describe("Texte (docs/09 §11)", () => {
  it("enthalten keine Ausrufezeichen, Emojis oder verbotenen Floskeln", () => {
    const forbidden = /oops|hoppla|let's go|tauche ein|magisch|nahtlos|revolution/i;
    const texts = allTexts();
    for (const [path, text] of texts) {
      expect(text, path).not.toContain("!");
      expect(text, path).not.toMatch(/\p{Extended_Pictographic}|\u{FE0F}/u);
      expect(text, path).not.toMatch(forbidden);
    }
    expect(texts.length).toBeGreaterThan(100);
  });

  it("stimmen mit den festen Texten aus docs/09 §11 überein", () => {
    expect(de.app.claim).toBe("Das Quiz-Duell für deine Runde.");
    expect(Object.values(de.actions)).toEqual(
      expect.arrayContaining([
        "Lobby erstellen",
        "Beitreten",
        "Spiel starten",
        "Fertig",
        "Fragen ansehen",
        "Ergebnis ansehen",
        "Lobby verlassen",
        "Zur Startseite",
        "Erneut versuchen",
      ]),
    );
    expect([de.fields.name, de.fields.lobbyCode]).toEqual(["Dein Name", "Lobby-Code"]);
    expect([de.settings.rounds, de.settings.questionsPerCategory, de.settings.maxPlayers]).toEqual([
      "Runden",
      "Fragen pro Kategorie",
      "Personen maximal",
    ]);
    expect(de.dialogs.resign).toEqual({
      title: "Spiel verlassen?",
      description: "Du giltst dann als aufgegeben.",
      confirm: "Verlassen",
      cancel: "Weiterspielen",
    });
    expect(de.dialogs.leaveLobby).toEqual({ title: "Lobby verlassen?", confirm: "Verlassen", cancel: "Bleiben" });
    // ADR-051, gekürzt auf 2 Zeilen bei 360 px (Dialog: max. 2 Zeilen Text, docs/09 §5)
    expect(de.dialogs.endGame).toEqual({
      title: "Spiel für alle beenden?",
      description: "Alle sehen den aktuellen Stand, danach geht es zurück in die Lobby.",
      confirm: "Beenden",
      cancel: "Weiterspielen",
    });
    expect(de.connection.lost).toBe("Verbindung unterbrochen");
    expect([de.pwa.install, de.pwa.updateAvailable, de.pwa.update, de.pwa.offline]).toEqual([
      "Als App installieren",
      "Neue Version verfügbar",
      "Aktualisieren",
      "Du bist offline.",
    ]);
    expect([de.result.won, de.result.lost, de.result.draw, de.result.resigned]).toEqual([
      "Gewonnen",
      "Verloren",
      "Unentschieden",
      "Aufgegeben",
    ]);
  });

  it("setzt Platzhalter für Namen und Zahlen ein", () => {
    expect(de.lobby.players(3, 8)).toBe("Spieler 3/8");
    expect(de.lobby.waitingFor("Mia")).toBe("Warte auf Mia …");
    expect(de.lobby.durationSummary(27, 9)).toBe("27 Fragen · ca. 9 Min.");
    expect(de.lobby.settingsSummary(3, 3)).toBe("3 Runden · 3 Fragen je Kat.");
    expect(de.lobby.settingsSummary(1, 1)).toBe("1 Runde · 1 Frage je Kat.");
    expect(de.game.pickOther("Mia")).toBe("Mia wählt eine Kategorie");
    expect(de.game.questionProgress(1, 3)).toBe("Frage 1/3");
    expect(de.game.waitingForOthers(2)).toBe("Warte auf 2 weitere …");
    expect(de.game.progress(2, 3, 3, 4)).toBe("Runde 2/3 · Zug 3/4");
    // Ohne Wahl ein Zug je Runde (ADR-056): kein „Zug 1/1“.
    expect(de.game.progress(2, 3, 1, 1)).toBe("Runde 2/3");
    expect(de.game.revealSubtitle(3, "Mia")).toBe("3 Fragen · gewählt von Mia");
    expect(de.result.playerWins("Mia")).toBe("Mia gewinnt");
    expect(de.result.place(2)).toBe("Platz 2");
    expect(de.result.points(1)).toBe("1 Punkt");
    expect(de.game.duelScore(7, 5)).toBe("7 : 5");
  });

  it("formuliert die Screenreader-Ansagen aus docs/09 §7", () => {
    expect(de.announcements.roundPick(2, 3, "Mia")).toBe("Runde 2 von 3. Mia wählt eine Kategorie.");
    expect(de.announcements.categoryQuestion("Bücher & Wörter", 1, 3)).toBe("Bücher und Wörter. Frage 1 von 3.");
    expect(de.announcements.correct).toBe("Richtig. Plus 1 Punkt.");
    expect(de.announcements.wrong("Donau")).toBe("Falsch. Richtig war: Donau.");
    expect(de.announcements.roundEnded(1, 2)).toBe("Runde 1 beendet. Du bist auf Platz 2.");
    expect(spokenCategoryName("Essen & Trinken")).toBe("Essen und Trinken");
  });

  it("enthält auch die früheren Client-Zusatztexte (Start, Lobby, Entfernen-Dialog, Spiel, Review)", () => {
    expect([de.start.nameRequired, de.start.codeIncomplete]).toEqual([
      "Gib deinen Namen ein.",
      "Gib den ganzen Code ein.",
    ]);
    expect([de.lobby.codeCopied, de.lobby.linkCopied, de.lobby.copyFailed, de.lobby.addBot]).toEqual([
      "Code kopiert.",
      "Link kopiert.",
      "Kopieren nicht möglich.",
      "Bot hinzufügen",
    ]);
    expect(de.lobby.inviteText("ABC 234")).toBe("Tritt meiner Lobby bei: ABC 234");
    expect(de.dialogs.kick.title("Ben")).toBe("Ben entfernen?");
    expect(de.dialogs.kick.description("Ben")).toBe("Ben kann dieser Lobby nicht wieder beitreten.");
    expect([de.dialogs.kick.confirm, de.dialogs.kick.cancel]).toEqual(["Entfernen", "Abbrechen"]);
    expect(de.announcements.roundPickSelf(2, 3)).toBe("Runde 2 von 3. Wähle eine Kategorie.");
    expect([de.a11y.playerStrip, de.game.unknownCategory, de.review.empty]).toEqual([
      "Spielstand",
      "Kategorie",
      "Noch keine Fragen gespielt.",
    ]);
    expect(de.game.answerNotReceived).toBe("Deine Antwort kam nicht an. Tippe noch einmal.");
    expect(de.pages.notFound).toBe("Seite nicht gefunden.");
  });

  it("nennt alle fünf Meldegründe und den Wartungstext mit Rückfall", () => {
    expect(REPORT_REASONS.map((reason) => de.report.reasons[reason])).toEqual([
      "Falsch",
      "Mehrdeutig",
      "Veraltet",
      "Tippfehler",
      "Unpassend",
    ]);
    expect(de.report.thanks).toBe("Danke, wir prüfen die Frage.");
    expect(de.maintenance.message(null)).toBe("Wartung – gleich geht es weiter.");
    expect(de.maintenance.message("  ")).toBe("Wartung – gleich geht es weiter.");
    expect(de.maintenance.message("Update um 22 Uhr.")).toBe("Update um 22 Uhr.");
  });
});

describe("Fehlercodes → Darstellung (docs/09 §11)", () => {
  it("hat für jeden Protokoll-Code genau eine Darstellung", () => {
    expect(Object.keys(errorPresentations).sort()).toEqual([...PROTOCOL_ERROR_CODES].sort());
    expect([...ERROR_CODES].sort()).toEqual([...PROTOCOL_ERROR_CODES].sort());
  });

  it("zeigt die Texte der Tabelle", () => {
    expect(errorMessage("LOBBY_NOT_FOUND")).toBe("Lobby nicht gefunden.");
    expect(errorMessage("LOBBY_FULL")).toBe("Die Lobby ist voll.");
    expect(errorMessage("GAME_IN_PROGRESS")).toBe("Das Spiel läuft bereits.");
    expect(errorMessage("NAME_REJECTED")).toBe("Name nicht erlaubt.");
    expect(errorMessage("NOT_ENOUGH_PLAYERS")).toBe("Mindestens 2 Personen nötig.");
    expect(errorMessage("RATE_LIMITED")).toBe("Zu viele Versuche. Warte kurz.");
    expect(errorMessage("SERVER_BUSY")).toBe("Gerade ist viel los. Versuch es gleich noch mal.");
    expect(errorMessage("TOO_MANY_CONNECTIONS")).toBe("Zu viele offene Verbindungen. Schließ andere Tabs.");
    expect(errorMessage("KICKED")).toBe("Du wurdest aus der Lobby entfernt.");
    expect(errorMessage("BANNED")).toBe("Du bist vorübergehend gesperrt.");
    expect(errorMessage("RESIGNED")).toBe("Du hast dieses Spiel verlassen.");
    expect(errorMessage("LOBBY_CREATION_DISABLED")).toBe("Neue Lobbys sind gerade pausiert.");
    expect(errorMessage("VALIDATION_FAILED")).toBe("Da ist etwas schiefgelaufen. Versuch es noch mal.");
    expect(errorMessage("INTERNAL")).toBe("Da ist etwas schiefgelaufen. Versuch es noch mal.");
  });

  it("behandelt Update, Anmeldung, Turnstile und Synchronisierung ohne Text", () => {
    expect(errorPresentation("UPDATE_REQUIRED")).toEqual({ kind: "update" });
    expect(errorPresentation("UNAUTHORIZED")).toEqual({
      kind: "reauth",
      fallback: "Sitzung abgelaufen. Lade die Seite neu.",
    });
    expect(errorPresentation("TURNSTILE_REQUIRED")).toEqual({ kind: "turnstile" });
    for (const code of ["NOT_HOST", "NOT_YOUR_TURN", "INVALID_OPTION", "INVALID_PHASE", "ALREADY_ANSWERED"]) {
      expect(errorPresentation(code)).toEqual({ kind: "resync" });
      expect(errorMessage(code)).toBeNull();
    }
  });

  it("zeigt bei unbekannten Codes den allgemeinen Fehler – nie die Server-Nachricht", () => {
    expect(errorMessage("SOMETHING_NEW")).toBe("Da ist etwas schiefgelaufen. Versuch es noch mal.");
    expect(errorMessage("toString")).toBe("Da ist etwas schiefgelaufen. Versuch es noch mal.");
  });

  it("übersetzt kicked-Gründe", () => {
    expect(kickedMessage("host")).toBe("Du wurdest aus der Lobby entfernt.");
    expect(kickedMessage("abuse")).toBe("Du bist vorübergehend gesperrt.");
    expect(kickedMessage("inactive")).toBe("Du wurdest wegen Inaktivität entfernt.");
  });
});
