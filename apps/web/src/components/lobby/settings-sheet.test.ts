/**
 * Einstellungen-Sheet: Die Zusammenfassungszeile bricht bei 360 px nur zwischen ihren Teilen um – nie mitten in
 * „ca. 6 Min.“ (Befund W3: „… ca. 6“ / „Min.“). Serverseitig gerendert – geprüft wird das Markup.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  categorySummary,
  SettingsSummary,
  settingsSummaryParts,
  sortedCategories,
  toggleCategory,
} from "./settings-sheet";

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
