/**
 * Spiel-Screen (docs/09 §4, §7; ADR-045/049/060): Die Host-Aktion („Auflösen (2/3 Antworten)“ bzw. „Weiter“) und der
 * Hinweis „Warte auf Mia …“ stehen in der Zone des Spielerstreifens – nie in einer eigenen Leiste darunter, die der
 * Bühne Höhe nimmt (bei 360 × 740 verdeckte sie Antwort D): wo Platz ist, in einer zweiten Zeile unter den Personen,
 * sonst neben bzw. statt der Liste. Dazu die dauerhafte Live-Region für „Verbindung hakt“ (ADR-057). Serverseitig
 * gerendert – geprüft wird das Markup.
 */
import type { PublicPlayer } from "@quizmaster/shared";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PREVIEW_CATALOG, PREVIEW_VIEWS, type PreviewViewId } from "../../app/dev/game/sample-states";
import { de } from "../../i18n/de";
import { GameScreen, type GameScreenProps } from "./game-screen";
import { PlayerStrip, type StripAction } from "./player-strip";

// Szenen relativ zur echten Uhr: Der Spiel-Screen liest sie (Standard-Uhr `Date.now`) wie im Live-Spiel.
const NOW = Date.now();
const noop = () => {};

function render(view: PreviewViewId, extra: Partial<GameScreenProps> = {}): string {
  const scene = PREVIEW_VIEWS[view].build({ now: NOW, count: 2 });
  if (scene.kind !== "game") throw new Error(`${view}: keine Spielszene`);
  const props: GameScreenProps = {
    lobby: scene.lobby,
    self: scene.self,
    categories: PREVIEW_CATALOG,
    pendingAnswer: null,
    pendingPick: null,
    syncGeneration: 0,
    soundOn: true,
    handlers: {
      onPick: noop,
      onAnswer: noop,
      onResign: noop,
      onToggleSound: noop,
      onLeave: noop,
      onContinue: noop,
      onEndGame: noop,
      onShowRules: noop,
    },
    ...extra,
  };
  return renderToStaticMarkup(h(GameScreen, props));
}

/** Markup des Elements, dessen Start-Tag `marker` enthält (samt Inhalt). */
function outerElement(html: string, marker: string): string | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.lastIndexOf("<", at);
  const tag = /^<([a-z]+)/.exec(html.slice(start))?.[1];
  if (!tag) return null;
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  pattern.lastIndex = start;
  let depth = 0;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index + match[0].length);
  }
  return null;
}

/** Bereich des Spielerstreifens (64-px-Zone unten). */
function stripZone(html: string): string {
  const zone = outerElement(html, 'data-testid="player-strip"');
  if (!zone) throw new Error("Spielerstreifen fehlt");
  return zone;
}

/** Klassen des Start-Tags eines Elements. */
function classesOf(element: string | null): string[] {
  const start = element?.slice(0, element.indexOf(">") + 1) ?? "";
  return (/class="([^"]*)"/.exec(start)?.[1] ?? "").split(/\s+/).filter(Boolean);
}

/** Orange Hauptaktionen (Button `primary`, docs/09 Regel 8). */
function primaryButtons(html: string): string[] {
  return html.match(/<button[^>]*class="[^"]*\bbg-primary\b[^"]*"[^>]*>/g) ?? [];
}

const ACTION_BAR = "sticky bottom-0";

describe("Host-Aktion in der Zone des Spielerstreifens, ohne Platz für eine zweite Zeile (ADR-045/049/060)", () => {
  // Serverseitig gerendert gilt der Viewport als nicht hoch (z. B. 360 × 740): die kompakte Lage in einer Zeile.
  it("Frage ohne Countdown, Host: „Auflösen (x/y Antworten)“ statt der Liste – der Spielstand bleibt für Screenreader", () => {
    const html = render("question-host");
    const zone = stripZone(html);
    expect(zone).toMatch(/^<div data-testid="player-strip" data-action-layout="instead"/);
    const button = outerElement(zone, 'data-testid="game-continue"');
    expect(button).not.toBeNull();
    expect(button).toContain(de.actions.revealNow(1, 2));
    // kompakt (44 px) über die volle Breite – die lange Beschriftung braucht sie (bei 360 px 264 px breit)
    expect(classesOf(button)).toEqual(expect.arrayContaining(["bg-primary", "min-h-11", "w-full"]));
    // Liste nur für Screenreader: nicht sichtbar, kein Scroll-Bereich, nicht fokussierbar (axe
    // „scrollable-region-focusable“ – auch mit 5–8 Personen)
    expect(zone).toContain('<div class="sr-only"><ul aria-label="Spielstand" class="flex items-center">');
    expect(zone.match(/data-testid="strip-player"/g)).toHaveLength(2);
    expect(zone).not.toMatch(/<ul[^>]*tabindex/);
    expect(primaryButtons(html)).toHaveLength(1);
    expect(html).not.toContain(ACTION_BAR);
  });

  it("Frage ohne Countdown, alle anderen: nur der Streifen mit den Personen, keine Aktion", () => {
    const html = render("question-host-guest");
    const zone = stripZone(html);
    expect(zone).toMatch(/^<div data-testid="player-strip" class=/);
    expect(zone.match(/data-testid="strip-player"/g)).toHaveLength(2);
    expect(html).not.toContain('data-testid="game-continue"');
    expect(html).not.toContain('data-testid="game-continue-waiting"');
    expect(primaryButtons(html)).toHaveLength(0);
    expect(html).not.toContain(ACTION_BAR);
  });

  it("Auflösung wartet, Host: „Weiter“ kompakt neben den Personen – die Liste scrollt in der Restbreite (Ausnahme)", () => {
    const html = render("answer-host");
    const zone = stripZone(html);
    expect(zone).toMatch(/^<div data-testid="player-strip" data-action-layout="beside"/);
    expect(zone.match(/data-testid="strip-player"/g)).toHaveLength(2);
    const button = outerElement(zone, 'data-testid="game-continue"');
    expect(button).toContain(de.actions.next);
    expect(classesOf(button)).toEqual(expect.arrayContaining(["bg-primary", "min-h-11"]));
    expect(classesOf(button)).not.toContain("w-full");
    // Die Liste steht vor der Aktion und scrollt in der Restbreite (ohne Umbruch – die Zone bleibt 64 px hoch),
    // per Tastatur erreichbar; die eigene Person steht vorn.
    expect(zone.indexOf("<ul")).toBeLessThan(zone.indexOf('data-testid="game-continue"'));
    const list = outerElement(zone, "<ul");
    expect(classesOf(list)).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "overflow-x-auto"]));
    expect(classesOf(list)).not.toContain("flex-wrap");
    expect(list).toMatch(/^<ul[^>]*tabindex="0"/);
    expect(primaryButtons(html)).toHaveLength(1);
    expect(html).not.toContain(ACTION_BAR);
  });

  it("Auflösung wartet, alle anderen: „Warte auf Mia …“ wie in der Lobby (ActionBarNote, kompakt) – keine orange Aktion", () => {
    const html = render("answer-host-guest");
    const zone = stripZone(html);
    expect(zone.match(/data-testid="strip-player"/g)).toHaveLength(2);
    const note = outerElement(zone, 'data-testid="game-continue-waiting"');
    expect(note).toContain(de.lobby.waitingFor("Mia"));
    expect(classesOf(note)).toEqual(
      expect.arrayContaining(["min-h-11", "text-body", "text-text-2", "text-center", "justify-center"]),
    );
    expect(classesOf(note)).not.toContain("text-caption");
    expect(primaryButtons(html)).toHaveLength(0);
    expect(html).not.toContain(ACTION_BAR);
  });

  it("Zug-Ergebnis wartet: dieselbe Zone – Host „Weiter“, alle anderen der Hinweis", () => {
    const host = stripZone(render("turn-summary-host"));
    expect(outerElement(host, 'data-testid="game-continue"')).toContain(de.actions.next);
    const guest = stripZone(render("turn-summary-host-guest"));
    expect(outerElement(guest, 'data-testid="game-continue-waiting"')).toContain(de.lobby.waitingFor("Mia"));
  });

  it("geht es automatisch weiter, gibt es weder Aktion noch Hinweis", () => {
    for (const view of ["answer-correct", "turn-summary", "question"] as const) {
      const html = render(view);
      expect(html, view).not.toContain('data-testid="game-continue"');
      expect(html, view).not.toContain('data-testid="game-continue-waiting"');
      expect(html, view).not.toContain("data-action-layout");
      expect(html, view).not.toContain(ACTION_BAR);
    }
  });
});

describe("Host-Aktion in einer zweiten Zeile, wo die Bühne Platz hat (ADR-060)", () => {
  const COLORS = ["blue", "sky", "cyan", "yellow", "ochre", "sand", "steel", "silver"] as const;
  function players(count: number): PublicPlayer[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `p${index}`,
      name: `Person ${index + 1}`,
      color: COLORS[index] ?? "blue",
      isHost: index === 0,
      isBot: false,
      connected: true,
      status: "active" as const,
      score: index,
    }));
  }
  const strip = (count: number, action: StripAction) =>
    renderToStaticMarkup(
      h(PlayerStrip, { players: players(count), selfId: "p1", answeredIds: [], action, stacked: true }),
    );
  const next: StripAction = {
    placement: "beside",
    content: h("button", { type: "button", "data-testid": "game-continue" }, "Weiter"),
  };
  const reveal: StripAction = {
    placement: "instead",
    content: h("button", { type: "button", "data-testid": "game-continue" }, "Auflösen (1/4 Antworten)"),
  };

  for (const count of [3, 4]) {
    it(`${count} Personen: verteilt wie ohne Aktion (kein Scrollen), die Aktion darunter über die volle Breite`, () => {
      for (const action of [next, reveal]) {
        const zone = strip(count, action);
        expect(zone).toMatch(/^<div data-testid="player-strip" data-action-layout="stacked"/);
        const list = outerElement(zone, "<ul");
        expect(classesOf(list)).toEqual(expect.arrayContaining(["flex-wrap", "justify-around", "w-full"]));
        expect(classesOf(list)).not.toContain("overflow-x-auto");
        expect(list).not.toMatch(/^<ul[^>]*tabindex/);
        expect(zone.match(/data-testid="strip-player"/g)).toHaveLength(count);
        // sichtbar – nicht nur für Screenreader wie in der Lage „instead“
        expect(zone).not.toContain('<div class="sr-only">');
        // Aktion unter der Liste: eigene Zeile in der Spalte
        expect(zone.indexOf("</ul>")).toBeLessThan(zone.indexOf('data-testid="game-continue"'));
        expect(zone).toMatch(/<\/ul><div class="mx-auto flex w-full max-w-column flex-col px-gutter pt-2">/);
      }
    });
  }

  it("statt der Liste: mit 8 Personen ebenso nur für Screenreader, ohne Scroll-Bereich", () => {
    const zone = renderToStaticMarkup(
      h(PlayerStrip, { players: players(8), selfId: "p1", answeredIds: [], action: reveal }),
    );
    expect(zone).toMatch(/^<div data-testid="player-strip" data-action-layout="instead"/);
    expect(zone).toContain('<div class="sr-only"><ul aria-label="Spielstand" class="flex items-center">');
    expect(zone).not.toContain("overflow-x-auto");
    expect(zone).not.toMatch(/<ul[^>]*tabindex/);
  });

  it("ab 5 Personen scrollt die Liste wie ohne Aktion über die volle Breite", () => {
    const list = outerElement(strip(5, next), "<ul");
    expect(classesOf(list)).toEqual(expect.arrayContaining(["overflow-x-auto", "w-full", "max-w-column"]));
    expect(classesOf(list)).not.toContain("flex-1");
    expect(list).toMatch(/^<ul[^>]*tabindex="0"/);
  });

  it("die eigene Person steht vorn", () => {
    const zone = strip(4, next);
    expect(zone.indexOf('data-player-id="p1"')).toBeLessThan(zone.indexOf('data-player-id="p0"'));
  });
});

describe("„Verbindung hakt“ (ADR-057): dauerhafte Live-Region", () => {
  /** Höfliche Live-Region (nur Screenreader) mit ihrem Text. */
  function announcer(html: string): string | null {
    return outerElement(html, 'data-testid="network-announcer"');
  }

  it("steht schon vor dem Aussetzer leer im DOM – nur so sagen Screenreader die Änderung zuverlässig an", () => {
    const quiet = render("question");
    const region = announcer(quiet);
    expect(region).toMatch(/^<p[^>]*role="status"/);
    expect(region).toMatch(/class="sr-only"/);
    expect(region).toMatch(/>\s*<\/p>$/);
    expect(quiet).not.toContain(de.network.stalled);
  });

  it("sagt den Hinweis an und zeigt das Banner – das Banner selbst ist keine zweite Ansage", () => {
    const stalled = render("question", { networkStalled: true });
    expect(announcer(stalled)).toContain(de.network.stalled);
    const banner = outerElement(stalled, 'data-testid="network-banner"');
    expect(banner).toMatch(/^<div[^>]*aria-hidden="true"/);
    expect(banner).toContain(de.network.stalled);
    // genau eine Ansage: die Live-Region; das sichtbare Banner ist für Screenreader verborgen
    expect(stalled.split(de.network.stalled)).toHaveLength(3);
  });
});
