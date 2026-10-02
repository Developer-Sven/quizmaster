import { DEFAULT_LOBBY_SETTINGS } from "@quizmaster/shared";
import { describe, expect, it } from "vitest";
import { renderHtml } from "../ui/ssr-render";
import { InvitePanel } from "./invite-panel";
import { LobbyAnnouncer } from "./lobby-announcer";
import { settingsExtras } from "./settings-extras";

const noop = () => {};

describe("Code-Zeile der Lobby (docs/09 §6)", () => {
  it("bricht nie den Code um, sondern lässt die Buttons in die nächste Zeile rücken", () => {
    const html = renderHtml(InvitePanel, {
      displayCode: "MWM WMW",
      inviteUrl: "",
      onCopyCode: noop,
      onShare: noop,
    });
    // Zeile darf umbrechen; der Code schrumpft nicht vorab (kein flex-1/min-w-0) – erst die Buttons weichen aus.
    expect(html).toMatch(/<div class="flex flex-wrap items-center gap-2"><p data-testid="lobby-code" class="mr-auto /);
    expect(html).not.toMatch(/data-testid="lobby-code" class="[^"]*(?:flex-1|min-w-0)/);
    expect(html).toMatch(/<div class="ml-auto flex gap-2"><button[^>]*data-testid="lobby-copy"/);
  });
});

describe("Ansagen der Lobby (WCAG 4.1.3)", () => {
  it("hat eine dauerhafte, unsichtbare Status-Region", () => {
    expect(renderHtml(LobbyAnnouncer, {})).toBe('<p role="status" class="sr-only" data-testid="lobby-announcer"></p>');
  });
});

describe("Zusatzzeile der Lobby-Zusammenfassung (ADR-046/048/049)", () => {
  const catalog = { sport: { id: "sport", name: "Sport", icon: "trophy", color: "#336699" } };

  it("nur Abweichungen vom Standard: feste Kategorie, Zeit pro Frage, anzeigender Host", () => {
    expect(settingsExtras({ ...DEFAULT_LOBBY_SETTINGS, categoryIds: null, answerSec: 20 }, catalog, null)).toEqual([]);
    expect(settingsExtras({ ...DEFAULT_LOBBY_SETTINGS, categoryIds: ["sport"], answerSec: 0 }, catalog, "Mia")).toEqual(
      ["Nur Sport", "Auflösen per Host", "Mia zeigt nur an"],
    );
    expect(
      settingsExtras({ ...DEFAULT_LOBBY_SETTINGS, categoryIds: ["sport", "erdkunde"], answerSec: 45 }, catalog, null),
    ).toEqual(["2 Kategorien", "45 s pro Frage"]);
  });

  it("Schwierigkeit nur, wenn nicht alle Stufen pro Frage aufsteigend (ADR-055); 5 s pro Frage", () => {
    expect(
      settingsExtras({ ...DEFAULT_LOBBY_SETTINGS, difficultyMin: 2, difficultyMax: 2, answerSec: 5 }, catalog, null),
    ).toEqual(["Schwierigkeit nur Stufe 2", "5 s pro Frage"]);
    expect(
      settingsExtras(
        {
          ...DEFAULT_LOBBY_SETTINGS,
          difficultyMin: 2,
          difficultyMax: 4,
          difficultyBasis: "category",
          difficultyOrder: "random",
        },
        catalog,
        null,
      ),
    ).toEqual(["Schwierigkeit 2–4, pro Kategorie zufällig"]);
  });
});
