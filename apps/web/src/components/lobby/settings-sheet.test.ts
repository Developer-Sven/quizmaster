/**
 * Einstellungen-Sheet: Die Zusammenfassungszeile bricht bei 360 px nur zwischen ihren Teilen um – nie mitten in
 * „ca. 6 Min.“ (Befund aus dem UI-Review: „… ca. 6“ / „Min.“). Serverseitig gerendert – geprüft wird das Markup.
 */

import { DEFAULT_LOBBY_SETTINGS } from "@quizmaster/shared";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CategoryChoice, SettingsSummary, SettingsValueRow, settingsSummaryParts } from "./settings-sheet";
import {
  categoriesNote,
  categoryModeHint,
  categoryOrderNote,
  categoryOrderText,
  categorySummary,
  categoryUpdate,
  difficultyPreview,
  difficultySummary,
  settingDiffers,
  settingValueText,
  sortedCategories,
  suggestionSummary,
  toggleCategory,
} from "./settings-text";

/** Sichtbarer bzw. vorgelesener Text eines Markups (ohne aria-hidden-Teile, mit aria-label). */
function accessibleText(html: string): string {
  const withoutHidden = html.replace(/<span aria-hidden="true"[^>]*>(?:(?!<\/span>).)*<\/span>/g, "");
  const labels = [...withoutHidden.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1]);
  const text = withoutHidden.replace(/<[^>]+>/g, " ");
  return [...labels, text].join(" ").replaceAll("&amp;", "&").replace(/\s+/g, " ").trim();
}

describe("Kategorien-Unteransicht: Zeilen (docs/09 §12)", () => {
  const books = { id: "buecher-woerter", name: "Bücher & Wörter", icon: "book-open", color: "#EBB447" };

  it("nennt jede Kategorie einmal – das Icon daneben ist dekorativ", () => {
    const html = renderToStaticMarkup(h(CategoryChoice, { category: books }));
    expect(accessibleText(html)).toBe("Bücher & Wörter");
    expect(html).toContain("lucide-book-open");
  });

  it("schneidet lange Namen bei Text-Zoom nicht ab, sondern bricht um", () => {
    const html = renderToStaticMarkup(h(CategoryChoice, { category: books }));
    expect(html).not.toContain("truncate");
    expect(html).toContain("wrap-break-word");
  });

  it("Hinweis zu „Wer dran ist, wählt“: für den Host „deiner Auswahl“, für alle anderen ohne Du (ADR-050)", () => {
    expect(categoryModeHint("pick", false)).toContain("deiner Auswahl");
    expect(categoryModeHint("pick", true)).toBe("Aus bis zu drei der ausgewählten Kategorien.");
    expect(categoryModeHint("pick", true)).not.toMatch(/\b(?:du|dein\w*)\b/i);
    expect(categoryModeHint("sequence", true)).toBe(categoryModeHint("sequence", false));
  });

  it("Hinweis stimmt auch bei zwei oder drei ausgewählten Kategorien (dann stehen alle zur Wahl, ADR-048)", () => {
    expect(categoryModeHint("pick", false)).toBe("Aus bis zu drei Kategorien deiner Auswahl.");
  });
});

describe("Einstellungen: Zeilen mit Wert rechts (Kategorien, Schwierigkeit)", () => {
  it("kürzt den Wert nie – passt er nicht neben die Beschriftung, rückt er darunter (Text-Zoom 200 %)", () => {
    const html = renderToStaticMarkup(
      h(SettingsValueRow, { label: "Schwierigkeit", value: "1–5, pro Kategorie aufsteigend" }),
    );
    expect(html).not.toContain("truncate");
    expect(html).toMatch(/^<span class="[^"]*\bflex-wrap\b/);
    expect(html).toMatch(/<span class="[^"]*\bwrap-break-word\b[^"]*">1–5, pro Kategorie aufsteigend<\/span>/);
  });

  it("zeigt abweichende Vorschläge mit „Aktuell: …“ unter der Beschriftung und den Wert in primary", () => {
    const html = renderToStaticMarkup(
      h(SettingsValueRow, { label: "Kategorien", value: "2 ausgewählt", note: "Aktuell: Alle" }),
    );
    expect(html).toContain('<span class="text-caption text-text-2">Aktuell: Alle</span>');
    expect(html).toMatch(/<span class="[^"]*\btext-primary\b[^"]*">2 ausgewählt<\/span>/);
    const plain = renderToStaticMarkup(h(SettingsValueRow, { label: "Kategorien", value: "Alle" }));
    expect(plain).toMatch(/<span class="[^"]*\btext-text-2\b[^"]*">Alle<\/span>/);
    expect(plain).not.toContain("Aktuell");
  });
});

describe("Einstellungen: Zusammenfassungszeile", () => {
  it("besteht aus den Teilen von Einstellungen und Schätzung (docs/09 §6, §11)", () => {
    expect(settingsSummaryParts({ rounds: 3, questionsPerCategory: 3 }, 3)).toEqual([
      "3 Runden",
      "3 Fragen je Kat.",
      "27 Fragen",
      "ca. 10 Min.",
    ]);
    expect(settingsSummaryParts({ rounds: 1, questionsPerCategory: 1 }, 1)).toEqual([
      "1 Runde",
      "1 Frage je Kat.",
      "1 Frage",
      "ca. 1 Min.",
    ]);
  });

  it("hält jeden Teil zusammen und erlaubt Umbrüche nur nach dem Trenner „·“", () => {
    const html = renderToStaticMarkup(
      h(SettingsSummary, { settings: { rounds: 2, questionsPerCategory: 3 }, players: 3 }),
    );
    const parts = [...html.matchAll(/<span class="whitespace-nowrap">([^<]*)<\/span>/g)].map((match) => match[1]);
    expect(parts).toEqual(["2 Runden", "3 Fragen je Kat.", "18 Fragen", "ca. 7 Min."]);
    // Außerhalb der Teile nur „ ·“ mit geschütztem Leerzeichen davor: Der Punkt landet nie am Zeilenanfang.
    const between = html
      .replace(/^<p[^>]*>|<\/p>$/g, "")
      .split(/<span class="whitespace-nowrap">[^<]*<\/span>/)
      .filter((gap) => gap !== "");
    const separator = `${String.fromCharCode(0xa0)}· `;
    expect(between).toEqual([separator, separator, separator]);
    expect(html).toContain("text-balance");
    expect(html).toContain('data-testid="settings-summary"');
  });
});

describe("Kategorien begrenzen (ADR-048)", () => {
  const catalog = {
    sport: { id: "sport", name: "Sport", icon: "trophy", color: "#336699" },
    "kunst-kultur": { id: "kunst-kultur", name: "Kunst & Kultur", icon: "palette", color: "#996633" },
    erdkunde: { id: "erdkunde", name: "Erdkunde", icon: "globe", color: "#339966" },
  };

  it("aus „Alle“ wird „nur diese“, weitere Tipps fügen hinzu bzw. nehmen weg, leer heißt wieder „Alle“", () => {
    expect(toggleCategory(null, "sport")).toEqual(["sport"]);
    expect(toggleCategory(["sport"], "erdkunde")).toEqual(["sport", "erdkunde"]);
    expect(toggleCategory(["sport", "erdkunde"], "sport")).toEqual(["erdkunde"]);
    expect(toggleCategory(["sport"], "sport")).toBeNull();
  });

  it("Zeile zeigt „Alle“, den Namen bei genau einer, sonst die Anzahl; Liste alphabetisch", () => {
    expect(categorySummary(null, catalog)).toBe("Alle");
    expect(categorySummary(["sport"], catalog)).toBe("Sport");
    expect(categorySummary(["sport", "erdkunde"], catalog)).toBe("2 ausgewählt");
    expect(sortedCategories(catalog).map((category) => category.name)).toEqual(["Erdkunde", "Kunst & Kultur", "Sport"]);
  });
});

describe("Vorschläge: Werte und Kurzfassung (ADR-053)", () => {
  const catalog = {
    sport: { id: "sport", name: "Sport", icon: "trophy", color: "#3F9FF3" },
    musik: { id: "musik", name: "Musik", icon: "music", color: "#26D9B5" },
  };

  it("zeigt jeden Wert wie im Sheet", () => {
    const settings = { ...DEFAULT_LOBBY_SETTINGS, answerSec: 0, categoryIds: ["sport"], hostPlays: false };
    expect(settingValueText(settings, "rounds", catalog)).toBe("3");
    expect(settingValueText(settings, "answerSec", catalog)).toBe("Host");
    expect(settingValueText(settings, "afterRoundSec", catalog)).toBe("7 s");
    expect(settingValueText(settings, "categoryIds", catalog)).toBe("Sport");
    expect(settingValueText(settings, "hostPlays", catalog)).toBe("zeigt nur an");
  });

  it("fasst nur die vorgeschlagenen Felder zusammen, in der Reihenfolge des Sheets", () => {
    expect(
      suggestionSummary({ answerSec: 30, rounds: 5, categoryIds: ["sport", "musik"] }, DEFAULT_LOBBY_SETTINGS, catalog),
    ).toBe("Runden: 5 · Kategorien: 2 ausgewählt · Zeit pro Frage: 30 s");
    expect(suggestionSummary({ hostPlays: false }, DEFAULT_LOBBY_SETTINGS, catalog)).toBe("Host: zeigt nur an");
  });
});

describe("Schwierigkeit: Zeile und Vorschau (ADR-055)", () => {
  it("fasst den Bereich und die Art zusammen", () => {
    expect(difficultySummary(DEFAULT_LOBBY_SETTINGS)).toBe("1–5, pro Frage aufsteigend");
    expect(difficultySummary({ ...DEFAULT_LOBBY_SETTINGS, difficultyMin: 3, difficultyMax: 3 })).toBe("nur Stufe 3");
    expect(
      difficultySummary({
        ...DEFAULT_LOBBY_SETTINGS,
        difficultyMin: 2,
        difficultyBasis: "category",
        difficultyOrder: "random",
      }),
    ).toBe("2–5, pro Kategorie zufällig");
  });

  it("zeigt in der Vorschau, was tatsächlich passiert", () => {
    const settings = { ...DEFAULT_LOBBY_SETTINGS, difficultyMax: 3 as const, questionsPerCategory: 6 };
    expect(difficultyPreview(settings, 2)).toBe("So läuft jede Kategorie: Stufe 1 · 1 · 2 · 2 · 3 · 3");
    expect(difficultyPreview({ ...settings, difficultyBasis: "category" }, 2)).toBe(
      "Kategorien nacheinander: Stufe 1 · 1 · 2 · 2 · 3 · 3",
    );
    expect(difficultyPreview({ ...settings, difficultyOrder: "random" }, 2)).toBe(
      "Jede Frage bekommt zufällig eine Stufe von 1 bis 3.",
    );
    expect(difficultyPreview({ ...settings, rounds: 10, difficultyBasis: "category" }, 8)).toMatch(/ …$/);
  });
});

describe("Kategorien der Reihe nach (ADR-056)", () => {
  const catalog = {
    sport: { id: "sport", name: "Sport", icon: "trophy", color: "#3F9FF3" },
    musik: { id: "musik", name: "Musik", icon: "music", color: "#26D9B5" },
  };
  const sequence = { ...DEFAULT_LOBBY_SETTINGS, categoryIds: ["sport", "musik"], categoryMode: "sequence" as const };

  it("hält Runden und Spielweise beim Ändern der Auswahl stimmig", () => {
    expect(categoryUpdate(DEFAULT_LOBBY_SETTINGS, ["sport"])).toEqual({ categoryIds: ["sport"] });
    expect(categoryUpdate(sequence, ["sport", "musik", "kunst"])).toEqual({
      categoryIds: ["sport", "musik", "kunst"],
      rounds: 3,
    });
    expect(categoryUpdate(sequence, ["sport"])).toEqual({ categoryIds: ["sport"], categoryMode: "pick" });
    expect(categoryUpdate(sequence, null)).toEqual({ categoryIds: null, categoryMode: "pick" });
  });

  it("zeigt Zeile und Reihenfolge", () => {
    expect(categorySummary(sequence.categoryIds, catalog, "sequence")).toBe("2 der Reihe nach");
    expect(categorySummary(sequence.categoryIds, catalog, "pick")).toBe("2 ausgewählt");
    expect(categoryOrderText(sequence.categoryIds, catalog)).toBe("1. Sport · 2. Musik");
  });
});

describe("Vorschlag, der nur die Reihenfolge der Kategorien ändert (ADR-053/056)", () => {
  const catalog = {
    "buecher-woerter": { id: "buecher-woerter", name: "Bücher & Wörter", icon: "book-open", color: "#EBB447" },
    comics: { id: "comics", name: "Comics", icon: "message-circle", color: "#F7DF45" },
    computerspiele: { id: "computerspiele", name: "Computerspiele", icon: "gamepad-2", color: "#B2DF49" },
  };
  const current = {
    ...DEFAULT_LOBBY_SETTINGS,
    categoryIds: ["buecher-woerter", "comics", "computerspiele"],
    categoryMode: "sequence" as const,
    rounds: 3,
  };
  const reordered = { ...current, categoryIds: ["comics", "computerspiele", "buecher-woerter"] };

  it("gilt der Reihe nach als Änderung – wie beim Server (`settingsChangesBetween`); beim Wählen nicht", () => {
    expect(settingDiffers(current, reordered, "categoryIds")).toBe(true);
    expect(settingDiffers(current, current, "categoryIds")).toBe(false);
    const picking = { ...current, categoryMode: "pick" as const };
    expect(settingDiffers(picking, { ...reordered, categoryMode: "pick" }, "categoryIds")).toBe(false);
  });

  it("die Zeile „Kategorien“ zeigt „Aktuell:“ mit der bisherigen Reihenfolge", () => {
    expect(categoriesNote(current, reordered, catalog)).toBe(
      "Aktuell: 1. Bücher & Wörter · 2. Comics · 3. Computerspiele",
    );
    expect(categoriesNote(current, current, catalog)).toBeUndefined();
    expect(categoriesNote(undefined, reordered, catalog)).toBeUndefined();
  });

  it("die Unteransicht zeigt unter „Reihenfolge: …“ die bisherige – nur wenn auch bisher der Reihe nach gespielt wird", () => {
    expect(categoryOrderNote(current, reordered, catalog)).toBe(
      "Aktuell: 1. Bücher & Wörter · 2. Comics · 3. Computerspiele",
    );
    expect(categoryOrderNote(current, current, catalog)).toBeUndefined();
    expect(categoryOrderNote({ ...current, categoryMode: "pick" }, reordered, catalog)).toBeUndefined();
  });

  it("Wert und Kurzfassung nennen der Reihe nach die Reihenfolge – der Host sieht, was er übernimmt", () => {
    expect(settingValueText(reordered, "categoryIds", catalog)).toBe(
      "1. Comics · 2. Computerspiele · 3. Bücher & Wörter",
    );
    expect(suggestionSummary({ categoryIds: reordered.categoryIds }, current, catalog)).toBe(
      "Kategorien: 1. Comics · 2. Computerspiele · 3. Bücher & Wörter",
    );
    // Beim Wählen bleibt es bei der Anzahl.
    expect(settingValueText({ ...reordered, categoryMode: "pick" }, "categoryIds", catalog)).toBe("3 ausgewählt");
  });
});
