import { describe, expect, it } from "vitest";
import {
  isReservedName,
  makeUniqueName,
  NAME_MAX_GRAPHEMES,
  NAME_MIN_GRAPHEMES,
  nameKey,
  normalizeName,
  RESERVED_NAMES,
  validateNameFormat,
} from "./names.ts";
import { countGraphemes, truncateGraphemes, wordTokens } from "./text.ts";

describe("normalizeName", () => {
  it("wendet NFKC an, trimmt und fasst Leerzeichen zusammen", () => {
    expect(normalizeName("  Mia   Sophie  ")).toBe("Mia Sophie");
    expect(normalizeName("Ｍｉａ")).toBe("Mia");
    expect(normalizeName("Mia\u00A0\u00A0S")).toBe("Mia S");
    expect(normalizeName("ﬁnn")).toBe("finn");
  });

  it("ist idempotent", () => {
    for (const raw of ["  Mia   Sophie ", "Ｂｅｎ", "émile"]) {
      expect(normalizeName(normalizeName(raw))).toBe(normalizeName(raw));
    }
  });
});

describe("validateNameFormat", () => {
  it("akzeptiert übliche Namen mit Umlauten, Akzenten, anderen Schriften und _ - .", () => {
    const names = [
      "Mia",
      "Jürgen",
      "Ömer",
      "Zoë",
      "Łukasz",
      "Anna-Lena",
      "Max_Mustermann",
      "J.R.",
      "Mia 2",
      "Ângela",
      "Ayşe",
      "Nguyễn",
      "Ελένη",
      "Дмитрий",
      "李小龍",
      "राहुल",
      "محمد",
    ];
    for (const name of names) expect(validateNameFormat(name), name).toEqual({ ok: true, name });
  });

  it("liefert den normalisierten Namen", () => {
    expect(validateNameFormat("  Mia   S  ")).toEqual({ ok: true, name: "Mia S" });
  });

  it("zählt Grapheme (Intl.Segmenter): Grenzen 2 und 16", () => {
    expect(NAME_MIN_GRAPHEMES).toBe(2);
    expect(NAME_MAX_GRAPHEMES).toBe(16);
    expect(validateNameFormat("")).toEqual({ ok: false, reason: "too_short" });
    expect(validateNameFormat("A")).toEqual({ ok: false, reason: "too_short" });
    expect(validateNameFormat(" A ")).toEqual({ ok: false, reason: "too_short" });
    expect(validateNameFormat("Al").ok).toBe(true);
    expect(validateNameFormat("A".repeat(16)).ok).toBe(true);
    expect(validateNameFormat("A".repeat(17))).toEqual({ ok: false, reason: "too_long" });
    // Buchstabe + Kombinationszeichen ohne vorkomponierte Form = 1 Graphem, 2 UTF-16-Einheiten.
    expect(validateNameFormat("q́".repeat(16)).ok).toBe(true);
    expect(validateNameFormat("q́".repeat(17))).toEqual({ ok: false, reason: "too_long" });
    expect(validateNameFormat("Ü".repeat(16)).ok).toBe(true);
    expect(validateNameFormat("x".repeat(1_000))).toEqual({ ok: false, reason: "too_long" });
    // NFKC erweitert „ﷺ“ auf 18 Zeichen; normalisiert gelten höchstens 64 UTF-16-Einheiten.
    expect(validateNameFormat("ﷺ")).toEqual({ ok: false, reason: "too_long" });
    expect(validateNameFormat("\u{1E900}\u{1E944}".repeat(16)).ok).toBe(true);
    expect(validateNameFormat("\u{1E900}\u{1E944}\u{1E945}".repeat(16))).toEqual({ ok: false, reason: "too_long" });
  });

  it("lehnt Zero-Width-, Bidi-, Steuer- und unsichtbare Zeichen ab", () => {
    const names = [
      "Mi\u200Ba",
      "Mia\u200D",
      "Mi\u200Ca",
      "\u202EaiM",
      "Mi\u2066a",
      "Mi\u200Fa",
      "Mia\u0000",
      "Mi\ta",
      "Mi\na",
      "Mia\u00AD",
      "Mi\uFEFFa",
      "Mia\u061C",
      "\u3164\u3164\u3164",
      "Mi\u034Fa",
    ];
    for (const name of names) expect(validateNameFormat(name), JSON.stringify(name)).toMatchObject({ ok: false });
  });

  it("lehnt Emojis und Symbole ab", () => {
    const names = [
      "Mia 😀",
      "👍👍",
      "Mia❤\uFE0F",
      "Mia❤",
      "Mia🇩🇪",
      "1\u{FE0F}\u{20E3}2",
      "Mia ☺",
      "Ben ✔",
      "Mia★",
      "Mia👍🏽",
    ];
    for (const name of names) {
      expect(validateNameFormat(name), name).toEqual({ ok: false, reason: "invalid_characters" });
    }
  });

  it("lehnt andere Satz- und Sonderzeichen ab", () => {
    for (const name of ["Mia!", "Mia@home", "<b>Mia</b>", "Mia#1", "Mia's", "Mia/Ben", "Mia,Ben", "$Mia"]) {
      expect(validateNameFormat(name), name).toEqual({ ok: false, reason: "invalid_characters" });
    }
  });

  it("verlangt mindestens einen Buchstaben oder eine Ziffer", () => {
    expect(validateNameFormat("..")).toEqual({ ok: false, reason: "needs_letter_or_digit" });
    expect(validateNameFormat("_-_")).toEqual({ ok: false, reason: "needs_letter_or_digit" });
    expect(validateNameFormat("42").ok).toBe(true);
  });

  it("lehnt „Zalgo“-Text und lose Kombinationszeichen ab", () => {
    expect(validateNameFormat("M̀́̂̃ia")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(validateNameFormat("́Mia")).toEqual({ ok: false, reason: "invalid_characters" });
    expect(validateNameFormat("Mia .́")).toEqual({ ok: false, reason: "invalid_characters" });
  });
});

describe("isReservedName", () => {
  it("sperrt die reservierten Namen aus docs/06 in allen Schreibweisen", () => {
    expect(RESERVED_NAMES).toEqual(["admin", "host", "system", "moderator", "quizmaster", "server"]);
    const names = [
      "admin",
      "ADMIN",
      "Host",
      "System",
      "Moderator",
      "Quizmaster",
      "QuizMaster",
      "Server",
      "4dm1n",
      "H0st",
      "A d m i n",
      "S.y.s.t.e.m",
      "Admin2",
      "admin_123",
      "Mia Host",
      "Sys Admin",
      "Mia H0st",
      "Sérver",
    ];
    for (const name of names) expect(isReservedName(name), name).toBe(true);
  });

  it("lässt ähnliche, aber andere Namen zu", () => {
    for (const name of ["Ghost", "Hostel", "Mia", "Observer", "Systematik", "Administrator", "Hosting 2"]) {
      expect(isReservedName(name), name).toBe(false);
    }
  });
});

describe("makeUniqueName", () => {
  it("hängt bei Kollision „ 2“, „ 3“ … an (Groß-/Kleinschreibung egal)", () => {
    expect(makeUniqueName("Mia", [])).toBe("Mia");
    expect(makeUniqueName("Mia", ["Ben"])).toBe("Mia");
    expect(makeUniqueName("Mia", ["Mia"])).toBe("Mia 2");
    expect(makeUniqueName("mia", ["MIA", "Mia 2"])).toBe("mia 3");
    expect(makeUniqueName("  Mia  ", ["Mia"])).toBe("Mia 2");
  });

  it("kürzt lange Namen, damit der Anhang in 16 Grapheme passt", () => {
    const long = "Maximilian Mülle";
    expect(countGraphemes(long)).toBe(16);
    const unique = makeUniqueName(long, [long]);
    expect(unique).toBe("Maximilian Mül 2");
    expect(countGraphemes(unique)).toBe(16);
    expect(makeUniqueName("Abcdefghijklm op", ["abcdefghijklm op"])).toBe("Abcdefghijklm 2");
  });

  it("vergleicht über nameKey", () => {
    expect(nameKey("  MIA  ")).toBe("mia");
  });
});

describe("Text-Helfer", () => {
  it("kürzt ohne Grapheme zu zerschneiden", () => {
    expect(truncateGraphemes("Zoë👍🏽ab", 2)).toBe("Zo");
    expect(truncateGraphemes("a👍🏽b", 2)).toBe("a👍🏽");
    expect(truncateGraphemes("abc", 0)).toBe("");
  });

  it("zerlegt in Wörter und verbindet Bruchstücke", () => {
    expect(wordTokens("f i c k")).toEqual(["fick"]);
    expect(wordTokens("hu-re sohn")).toEqual(["hure", "sohn"]);
    expect(wordTokens("anna l")).toEqual(["anna", "l"]);
    expect(wordTokens("max1988")).toEqual(["max", "1988"]);
  });
});
