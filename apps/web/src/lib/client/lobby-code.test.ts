import { describe, expect, it } from "vitest";
import { normalizeCodeInput } from "../ui/lobby-code";
import { displayLobbyCode, lobbyCodeFromParam } from "./lobby-code";
import { inviteLink, joinPath, lobbyPath } from "./paths";

describe("lobbyCodeFromParam (Routen /j/[code] und /lobby/[code])", () => {
  it("normalisiert Groß/Klein, Leerzeichen und Bindestriche", () => {
    expect(lobbyCodeFromParam("ABC234")).toBe("ABC234");
    expect(lobbyCodeFromParam("abc234")).toBe("ABC234");
    expect(lobbyCodeFromParam("abc-234")).toBe("ABC234");
    expect(lobbyCodeFromParam("ABC 234")).toBe("ABC234");
    expect(lobbyCodeFromParam("ABC%20234")).toBe("ABC234");
    expect(lobbyCodeFromParam("ａｂｃ２３４")).toBe("ABC234");
  });

  it("verwirft ungültige Codes (Länge, verwechselbare Zeichen, kaputte Kodierung)", () => {
    expect(lobbyCodeFromParam("ABC23")).toBeNull();
    expect(lobbyCodeFromParam("ABC2345")).toBeNull();
    expect(lobbyCodeFromParam("ABI234")).toBeNull(); // I ist nicht im Alphabet
    expect(lobbyCodeFromParam("ABO234")).toBeNull(); // O ebenso
    expect(lobbyCodeFromParam("AB0234")).toBeNull(); // 0 ebenso
    expect(lobbyCodeFromParam("%E0%A4%A")).toBeNull();
    expect(lobbyCodeFromParam("A".repeat(40))).toBeNull();
    expect(lobbyCodeFromParam("")).toBeNull();
  });

  it("passt zur Eingabe-Normalisierung der Startseite (Tippen, Einfügen, Link)", () => {
    for (const raw of ["abc 234", "ab-c2 3–4", "https://quiz.example/j/abc234", "ABC234"]) {
      expect(lobbyCodeFromParam(normalizeCodeInput(raw)), raw).toBe("ABC234");
    }
  });

  it("zeigt den Code mit Lücke an", () => {
    expect(displayLobbyCode("ABC234")).toBe("ABC 234");
  });
});

describe("Pfade und Einladungslink (docs/10 §Teilen)", () => {
  it("baut Lobby- und Beitreten-Pfad", () => {
    expect(lobbyPath("ABC234")).toBe("/lobby/ABC234");
    expect(joinPath("ABC234")).toBe("/j/ABC234");
  });

  it("baut https://<origin>/j/<CODE> ohne doppelte Schrägstriche", () => {
    expect(inviteLink("https://quizmaster.dev-sven.de", "ABC234")).toBe("https://quizmaster.dev-sven.de/j/ABC234");
    expect(inviteLink("https://quizmaster.dev-sven.de/", "ABC234")).toBe("https://quizmaster.dev-sven.de/j/ABC234");
    expect(inviteLink("http://127.0.0.1:3000", "XYZ789")).toBe("http://127.0.0.1:3000/j/XYZ789");
  });

  it("führt über den Link wieder zum selben Code", () => {
    const link = inviteLink("https://quizmaster.dev-sven.de", "HJK789");
    expect(normalizeCodeInput(link)).toBe("HJK789");
    expect(lobbyCodeFromParam(link.split("/j/")[1] ?? "")).toBe("HJK789");
  });
});
