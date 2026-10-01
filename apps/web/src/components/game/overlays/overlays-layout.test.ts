/**
 * Layout-Stabilität der Spiel-Overlays (CLS-Ziel < 0,05 je Sitzung, docs/07): Was sich innerhalb eines Overlays
 * ändert, darf die übrigen Teile nicht verschieben. Serverseitig gerendert – geprüft wird das Markup.
 */
import type { CategoryOption, PublicPlayer } from "@quizmaster/shared";
import { type ComponentType, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MotionProvider } from "../../../lib/ui/motion";
import { CategoryPickOverlay, type CategoryPickOverlayProps } from "./category-pick-overlay";
import { IntroOverlay } from "./intro-overlay";

const NOW = Date.now();
const noop = () => {};

function render<P extends object>(component: ComponentType<P>, props: P): string {
  return renderToStaticMarkup(h(MotionProvider, null, h(component as ComponentType<P>, props)));
}

function player(id: string, name: string): PublicPlayer {
  return { id, name, color: "blue", isHost: false, isBot: false, connected: true, status: "active", score: 0 };
}

const options: [CategoryOption, CategoryOption, CategoryOption] = [
  { id: "buecher-woerter", name: "Bücher & Wörter", icon: "book-open", color: "#EBB447" },
  { id: "musik-hits", name: "Musik & Hits", icon: "music", color: "#5988F8" },
  { id: "kinofilme", name: "Kinofilme", icon: "clapperboard", color: "#EE5858" },
];

function pick(props: Partial<CategoryPickOverlayProps>): string {
  return render(CategoryPickOverlay, {
    options,
    picker: player("p2", "Ben"),
    isPicker: false,
    canPick: false,
    pickedId: null,
    phaseStartedAt: NOW - 2_000,
    phaseEndsAt: NOW + 13_000,
    timerRunId: "run",
    onPick: noop,
    ...props,
  });
}

/** Kopfzeile der Kategoriewahl: alles bis zur Kachelgruppe. */
function header(html: string): string {
  return html.slice(0, html.indexOf("<fieldset"));
}

describe("Kategoriewahl: die Wahl verschiebt nichts", () => {
  it("hält bei Zuschauenden den Platz des Timer-Rings nach der Wahl frei (der Titel bricht nicht neu um)", () => {
    const before = header(pick({}));
    const after = header(pick({ pickedId: "musik-hits" }));
    expect(before).toContain('role="timer"');
    expect(after).not.toContain('role="timer"');
    expect(after).toMatch(/<span aria-hidden="true" class="size-12 shrink-0"><\/span>/);
    expect(after).toContain("Ben wählt eine Kategorie");
    expect(after).toContain("BE");
  });

  it("zeigt der wählenden Person auch nach ihrer Wahl „Wähle eine Kategorie“ ohne eigenen Avatar (docs/09 §7.2)", () => {
    const before = header(pick({ picker: player("p1", "Mia"), isPicker: true, canPick: true }));
    const after = header(pick({ picker: player("p1", "Mia"), isPicker: true, canPick: false, pickedId: "kinofilme" }));
    for (const html of [before, after]) {
      expect(html).toContain("Wähle eine Kategorie");
      expect(html).not.toContain("Mia wählt");
      expect(html).not.toContain(">MI<");
    }
  });
});

describe("Intro: die Titelkarte springt nicht", () => {
  const players = ["Mia", "Ben", "Lea", "Tom", "Ida"].map((name, index) => player(`p${index + 1}`, name));

  it("lässt die Personen unter der Titelkarte als unsichtbaren Platzhalter stehen", () => {
    const html = render(IntroOverlay, { players, phaseStartedAt: NOW - 3_400, round: 1 });
    expect(html).toContain("Runde 1");
    const peopleBlock = /<div aria-hidden="true"[^>]*class="col-start-1 row-start-1[^"]*"/.exec(html);
    expect(peopleBlock).not.toBeNull();
    expect(html).toContain('aria-label="Mia"');
  });

  it("zeigt vorher die Personen ohne Titelkarte", () => {
    const html = render(IntroOverlay, { players, phaseStartedAt: NOW - 1_000, round: 1 });
    expect(html).not.toContain("Runde 1");
    expect(html).not.toMatch(/<div aria-hidden="true"[^>]*class="col-start-1 row-start-1/);
  });
});
