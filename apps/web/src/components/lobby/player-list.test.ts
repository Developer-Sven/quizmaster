/**
 * Spielerliste der Lobby: Bestätigung „Ben zum Host machen?“ (ADR-047). Ebenen hängen sich im Browser an `body` –
 * hier rendert das Portal direkt an Ort und Stelle, damit das Markup des Dialogs prüfbar ist.
 */
import type { ReactNode } from "react";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { testPlayer } from "../../lib/client/test-support";
import { TransferHostDialog } from "./player-list";

vi.mock("../../lib/ui/portal", () => ({
  Portal: ({ children }: { children: ReactNode }) => children,
  useIsClient: () => true,
}));

const noop = () => undefined;

describe("Host übertragen (ADR-047)", () => {
  it("bestätigt mit primary – Host übertragen ist keine destruktive Aktion (Rot nur für Destruktives, docs/09 §1)", () => {
    const html = renderToStaticMarkup(
      h(TransferHostDialog, { heir: testPlayer("p2", { name: "Ben" }), onConfirm: noop, onCancel: noop }),
    );
    expect(html).toContain("Ben zum Host machen?");
    expect(html).toContain("Ben stellt dann ein und startet das Spiel.");
    const buttons = [...html.matchAll(/<button [^>]*class="([^"]*)"[^>]*>((?:(?!<\/button>).)*)<\/button>/g)].map(
      (match) => ({ classes: (match[1] ?? "").split(" "), label: match[2] ?? "" }),
    );
    const confirm = buttons.find((button) => button.label.includes("Übertragen"));
    expect(confirm?.classes).toContain("bg-primary");
    expect(confirm?.classes).not.toContain("text-danger");
    // Genau eine orange Aktion auf dieser Ebene; „Abbrechen“ bleibt secondary.
    expect(buttons.filter((button) => button.classes.includes("bg-primary"))).toHaveLength(1);
  });

  it("ist ohne ausgewählte Person geschlossen", () => {
    expect(renderToStaticMarkup(h(TransferHostDialog, { heir: null, onConfirm: noop, onCancel: noop }))).toBe("");
  });
});
