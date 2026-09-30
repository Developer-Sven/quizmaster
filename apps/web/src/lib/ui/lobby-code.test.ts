import { formatLobbyCode, isValidLobbyCode, normalizeLobbyCode } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { activeCodeCell, applyCodeInput, applyCodePaste, caretAfterSelect, normalizeCodeInput } from "./lobby-code";

describe("normalizeCodeInput", () => {
  it("macht Großbuchstaben und entfernt Leerzeichen und Bindestriche", () => {
    expect(normalizeCodeInput("abc 234")).toBe("ABC234");
    expect(normalizeCodeInput(" ab-c2 3–4 ")).toBe("ABC234");
    expect(normalizeCodeInput("abc 234")).toBe("ABC234");
  });

  it("begrenzt auf 6 Zeichen und verwirft Satzzeichen", () => {
    expect(normalizeCodeInput("ABC2345678")).toBe("ABC234");
    expect(normalizeCodeInput("A.B:C,2?3/4")).toBe("ABC234");
  });

  it("wandelt Vollbreiten-Zeichen um (NFKC)", () => {
    expect(normalizeCodeInput("ＡＢＣ２３４")).toBe("ABC234");
  });

  it("liest den Code aus einem eingefügten Einladungslink", () => {
    expect(normalizeCodeInput("https://quiz.example.com/j/abc234")).toBe("ABC234");
    expect(normalizeCodeInput("Komm rein: https://quiz.example.com/j/ABC234?x=1")).toBe("ABC234");
  });

  it("stimmt für gültige Eingaben mit normalizeLobbyCode aus @quizmaster/shared überein", () => {
    for (const input of ["abc234", "ABC 234", "abc-234", " a b c 2 3 4 ", "ＡＢＣ２３４", "xyz–789"]) {
      const shared = normalizeLobbyCode(input);
      expect(normalizeCodeInput(input), input).toBe(shared);
      expect(isValidLobbyCode(shared), input).toBe(true);
    }
    expect(formatLobbyCode(normalizeCodeInput("abc-234"))).toBe("ABC 234");
  });
});

describe("caretAfterSelect / activeCodeCell (Einfügemarke im CodeInput)", () => {
  it("lässt die Tastatur die Marke frei bewegen (Pfeile, Pos1, Umschalt+Pfeil – WCAG 2.1.1)", () => {
    expect(caretAfterSelect("keyboard", 5, 5, 6)).toBeNull();
    expect(caretAfterSelect("keyboard", 0, 0, 6)).toBeNull();
    expect(caretAfterSelect("keyboard", 5, 6, 6)).toBeNull();
    expect(caretAfterSelect("keyboard", 0, 6, 6)).toBeNull();
  });

  it("setzt die Marke nach Tippen/Klicken ans Ende – die Klickposition entspricht keiner Zelle", () => {
    expect(caretAfterSelect("pointer", 2, 2, 6)).toBe(6);
    expect(caretAfterSelect("pointer", 1, 3, 4)).toBe(4);
    expect(caretAfterSelect("pointer", 6, 6, 6)).toBeNull();
    expect(caretAfterSelect("pointer", 0, 6, 6)).toBeNull();
    expect(caretAfterSelect("pointer", 0, 0, 0)).toBeNull();
  });

  it("zeigt die aktive Zelle an der Einfügemarke, höchstens die letzte Zelle", () => {
    expect(activeCodeCell(3, null)).toBe(3);
    expect(activeCodeCell(6, null)).toBe(5);
    expect(activeCodeCell(6, 2)).toBe(2);
    expect(activeCodeCell(6, 0)).toBe(0);
    expect(activeCodeCell(2, 5)).toBe(2);
  });
});

describe("applyCodeInput / applyCodePaste", () => {
  it("meldet die Vervollständigung genau beim sechsten Zeichen", () => {
    expect(applyCodeInput("ABC23", "ABC234")).toEqual({ value: "ABC234", completed: true });
    expect(applyCodeInput("ABC2", "ABC23")).toEqual({ value: "ABC23", completed: false });
    expect(applyCodeInput("ABC234", "ABC2345")).toEqual({ value: "ABC234", completed: false });
  });

  it("verwirft Einfügungen in einen vollen Code, statt Zeichen hinauszuschieben (kein falscher Auto-Beitritt)", () => {
    // Marke per Tastatur in der Mitte, „x“ getippt: ohne Schutz würde „ABXC23“ als vollständig gemeldet
    expect(applyCodeInput("ABC234", "ABxC234")).toEqual({ value: "ABC234", completed: false });
    expect(applyCodeInput("ABC234", "xABC234")).toEqual({ value: "ABC234", completed: false });
    // Ersetzen per Markierung (Umschalt+Pfeil, Alles markieren) und Löschen bleiben möglich
    expect(applyCodeInput("ABC234", "ABX234")).toEqual({ value: "ABX234", completed: true });
    expect(applyCodeInput("ABC234", "x")).toEqual({ value: "X", completed: false });
    expect(applyCodeInput("ABC234", "AB234")).toEqual({ value: "AB234", completed: false });
    // ein hineingezogener Einladungslink ersetzt den Code weiterhin
    expect(applyCodeInput("ABC234", "ABC234https://q.example/j/DEF567")).toEqual({ value: "DEF567", completed: true });
  });

  it("ersetzt beim Einfügen eines ganzen Codes die bisherige Eingabe", () => {
    expect(applyCodePaste("XY", "abc-234")).toEqual({ value: "ABC234", completed: true });
    expect(applyCodePaste("XY", "https://q.example/j/DEF567")).toEqual({ value: "DEF567", completed: true });
  });

  it("hängt Teilstücke an", () => {
    expect(applyCodePaste("AB", "c 2")).toEqual({ value: "ABC2", completed: false });
    expect(applyCodePaste("ABC2", "34")).toEqual({ value: "ABC234", completed: true });
  });
});
