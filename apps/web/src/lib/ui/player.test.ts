import { PLAYER_COLORS } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { initialsOf, isPlayerColor, PLAYER_COLOR_BG, PLAYER_COLOR_ORDER, playerColorBg } from "./player";

describe("Spielerfarben", () => {
  it("haben die Vergabe-Reihenfolge aus docs/05 (@quizmaster/shared) und je eine Token-Klasse", () => {
    expect(PLAYER_COLOR_ORDER).toEqual(["blue", "sky", "cyan", "yellow", "ochre", "sand", "steel", "silver"]);
    expect(PLAYER_COLOR_ORDER).toEqual([...PLAYER_COLORS]);
    for (const color of PLAYER_COLORS) expect(PLAYER_COLOR_BG[color]).toBe(`bg-player-${color}`);
  });

  it("enthalten weder Grün noch Rot, Pink oder Lila", () => {
    for (const forbidden of ["green", "red", "pink", "purple", "violet", "indigo"]) {
      expect(isPlayerColor(forbidden)).toBe(false);
    }
  });

  it("fallen bei unbekannten Werten auf die erste Farbe zurück", () => {
    expect(playerColorBg("magenta")).toBe("bg-player-blue");
    expect(playerColorBg("toString")).toBe("bg-player-blue");
  });
});

describe("initialsOf", () => {
  it("nimmt bei einem Wort die ersten zwei Zeichen", () => {
    expect(initialsOf("Lea")).toBe("LE");
    expect(initialsOf("mia")).toBe("MI");
    expect(initialsOf("A")).toBe("A");
  });

  it("nimmt bei mehreren Wörtern Anfang des ersten und letzten Wortes", () => {
    expect(initialsOf("Mia Schmidt")).toBe("MS");
    expect(initialsOf("Mia 2")).toBe("M2");
    expect(initialsOf("anna-lena_b")).toBe("AB");
  });

  it("ist graphem-sicher und bleibt bei zwei Zeichen", () => {
    expect(initialsOf("Ölaf")).toBe("ÖL");
    expect(initialsOf("ßa")).toBe("SS");
    expect(initialsOf("  ")).toBe("");
  });
});
