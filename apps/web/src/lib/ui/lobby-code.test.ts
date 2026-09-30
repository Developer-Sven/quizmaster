import { formatLobbyCode, isValidLobbyCode, normalizeLobbyCode } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { applyCodeInput, applyCodePaste, normalizeCodeInput } from "./lobby-code";

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

describe("applyCodeInput / applyCodePaste", () => {
  it("meldet die Vervollständigung genau beim sechsten Zeichen", () => {
    expect(applyCodeInput("ABC23", "ABC234")).toEqual({ value: "ABC234", completed: true });
    expect(applyCodeInput("ABC2", "ABC23")).toEqual({ value: "ABC23", completed: false });
    expect(applyCodeInput("ABC234", "ABC2345")).toEqual({ value: "ABC234", completed: false });
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
