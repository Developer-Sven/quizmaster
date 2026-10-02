/**
 * Einstellungen-Sheet: Die Zusammenfassungszeile bricht bei 360 px nur zwischen ihren Teilen um – nie mitten in
 * „ca. 6 Min.“ (Befund W3: „… ca. 6“ / „Min.“). Serverseitig gerendert – geprüft wird das Markup.
 */

import { DEFAULT_LOBBY_SETTINGS } from "@quizmaster/shared";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsSummary, settingsSummaryParts } from "./settings-sheet";
import {
  categorySummary,
  settingValueText,
  sortedCategories,
  suggestionSummary,
  toggleCategory,
} from "./settings-text";

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
