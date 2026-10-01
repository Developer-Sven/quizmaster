import { describe, expect, it } from "vitest";
import { renderHtml } from "../ui/ssr-render";
import { InvitePanel } from "./invite-panel";
import { LobbyAnnouncer } from "./lobby-announcer";

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
