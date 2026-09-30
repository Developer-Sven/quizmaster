import { describe, expect, it, vi } from "vitest";
import {
  codeAsLetters,
  drawLobbyCode,
  formatLobbyCode,
  generateLobbyCode,
  isLobbyCodeClean,
  isValidLobbyCode,
  LOBBY_CODE_ALPHABET,
  LOBBY_CODE_BLOCKLIST,
  LOBBY_CODE_LENGTH,
  LOBBY_CODE_MAX_ATTEMPTS,
  normalizeLobbyCode,
} from "./lobby-code.ts";

/** Deterministische Zufallsquelle, die nacheinander genau die Zeichen der angegebenen Codes liefert. */
function scriptedRandom(...codes: string[]) {
  const indexes = codes.flatMap((code) => Array.from(code, (char) => LOBBY_CODE_ALPHABET.indexOf(char)));
  let position = 0;
  return (max: number): number => {
    const value = indexes[position++];
    if (value === undefined || value < 0 || value >= max) throw new Error("Zufallsskript erschöpft");
    return value;
  };
}

describe("Alphabet", () => {
  it("hat 31 eindeutige Zeichen ohne I, L, O, 0, 1 → ca. 887 Mio. Codes", () => {
    expect(LOBBY_CODE_ALPHABET).toHaveLength(31);
    expect(new Set(LOBBY_CODE_ALPHABET).size).toBe(31);
    for (const char of "ILO01") expect(LOBBY_CODE_ALPHABET).not.toContain(char);
    expect(LOBBY_CODE_ALPHABET.length ** LOBBY_CODE_LENGTH).toBe(887_503_681);
  });
});

describe("normalizeLobbyCode / isValidLobbyCode / formatLobbyCode", () => {
  it.each([
    ["abc234", "ABC234"],
    ["ABC 234", "ABC234"],
    ["abc-234", "ABC234"],
    [" a b c – 2 3 4 ", "ABC234"],
    ["ＡＢＣ２３４", "ABC234"],
  ])("normalisiert %j → %s", (input, expected) => {
    expect(normalizeLobbyCode(input)).toBe(expected);
    expect(isValidLobbyCode(normalizeLobbyCode(input))).toBe(true);
  });

  it("lehnt falsche Längen, verwechselbare Zeichen und Nicht-Normalisiertes ab", () => {
    for (const code of ["ABC23", "ABC2345", "ABCI23", "ABCO23", "ABC012", "ABL234", "abc234", "ABC 234", ""]) {
      expect(isValidLobbyCode(code), code).toBe(false);
    }
  });

  it("zeigt Codes mit Lücke an", () => {
    expect(formatLobbyCode("abc234")).toBe("ABC 234");
    expect(formatLobbyCode("ABC 234")).toBe("ABC 234");
    expect(formatLobbyCode("abc")).toBe("ABC");
  });
});

describe("Code-Blockliste", () => {
  it("verwirft gesperrte Folgen – auch in Leetspeak-Lesart der Ziffern", () => {
    for (const code of ["FUCKAB", "XSEX23", "5EXABC", "NEGER2", "HURE23", "KZ2345", "AB55CD", "AB88CD", "NSDAP2"]) {
      expect(isLobbyCodeClean(code), code).toBe(false);
    }
    expect(isLobbyCodeClean("acab-xy")).toBe(false);
  });

  it("lässt unauffällige Codes zu", () => {
    for (const code of ["ABC234", "XYZ789", "QRT2M4", "HJM3NP"]) expect(isLobbyCodeClean(code), code).toBe(true);
  });

  it("liest Ziffern als ähnliche Buchstaben", () => {
    expect(codeAsLetters("5EX234")).toBe("SEXZEA");
  });

  it("enthält nur Zeichen des Code-Alphabets", () => {
    for (const entry of LOBBY_CODE_BLOCKLIST) {
      for (const char of entry) expect(LOBBY_CODE_ALPHABET, entry).toContain(char);
    }
  });
});

describe("generateLobbyCode", () => {
  it("liefert einen gültigen, unbedenklichen Code", async () => {
    const code = await generateLobbyCode(
      (max) => Math.floor(Math.random() * max),
      () => false,
    );
    expect(code).not.toBeNull();
    expect(isValidLobbyCode(code ?? "")).toBe(true);
    expect(isLobbyCodeClean(code ?? "")).toBe(true);
  });

  it("verwirft Blocklisten-Treffer, ohne nach Kollisionen zu fragen", async () => {
    const asked: string[] = [];
    const code = await generateLobbyCode(scriptedRandom("FUCKAB", "ABC234"), (candidate) => {
      asked.push(candidate);
      return false;
    });
    expect(code).toBe("ABC234");
    expect(asked).toEqual(["ABC234"]);
  });

  it("zieht bei Kollision neu – auch mit asynchroner Prüfung", async () => {
    const code = await generateLobbyCode(
      scriptedRandom("ABC234", "XYZ789"),
      async (candidate) => candidate === "ABC234",
    );
    expect(code).toBe("XYZ789");
  });

  it("gibt nach 5 Versuchen auf (null)", async () => {
    const isTaken = vi.fn(() => true);
    const code = await generateLobbyCode(scriptedRandom(...Array<string>(5).fill("ABC234")), isTaken);
    expect(LOBBY_CODE_MAX_ATTEMPTS).toBe(5);
    expect(code).toBeNull();
    expect(isTaken).toHaveBeenCalledTimes(5);
  });

  it("zählt Blocklisten-Treffer als Versuch und nutzt eine übergebene Prüfung", async () => {
    const code = await generateLobbyCode(scriptedRandom("ABC234", "XYZ789"), () => false, {
      isAcceptable: (candidate) => candidate !== "ABC234",
      maxAttempts: 2,
    });
    expect(code).toBe("XYZ789");
    const none = await generateLobbyCode(scriptedRandom("ABC234"), () => false, {
      isAcceptable: () => false,
      maxAttempts: 1,
    });
    expect(none).toBeNull();
  });

  it("wirft bei einer fehlerhaften Zufallsquelle", () => {
    expect(() => drawLobbyCode(() => 31)).toThrow(RangeError);
    expect(() => drawLobbyCode(() => 1.5)).toThrow(RangeError);
    expect(() => drawLobbyCode(() => -1)).toThrow(RangeError);
  });
});
