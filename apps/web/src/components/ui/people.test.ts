import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar } from "./avatar";
import { PlayerRow } from "./player-row";
import { Podium, podiumGrowStep } from "./podium";
import { RankingList } from "./ranking-list";
import { ScorePill } from "./score-pill";

describe("Avatar", () => {
  it("zeigt Initialen in bg auf der Spielerfarbe und ist ohne Label dekorativ", () => {
    const html = renderToStaticMarkup(h(Avatar, { name: "Lea", color: "cyan", size: 56 }));
    expect(html).toContain("bg-player-cyan");
    expect(html).toContain('class="relative text-bg"');
    expect(html).toContain("size-14");
    expect(html).toContain(">LE<");
    expect(html).toMatch(/^<span aria-hidden="true"/);
  });

  it("zeigt Zustände mit Badges, Ringen und Deckkraft", () => {
    const offline = renderToStaticMarkup(h(Avatar, { name: "Lea", color: "cyan", offline: true }));
    expect(offline).toContain("bg-player-cyan opacity-40");
    expect(offline).toContain('class="relative text-text"');
    expect(offline).toContain("lucide-wifi-off");
    const host = renderToStaticMarkup(h(Avatar, { name: "Mia", color: "blue", host: true }));
    expect(host).toContain("lucide-crown");
    const answered = renderToStaticMarkup(h(Avatar, { name: "Ben", color: "sky", answered: true }));
    expect(answered).toContain("outline-2 outline-offset-2 outline-text");
    expect(answered).toContain("lucide-check");
    expect(answered).toContain("motion-safe:animate-pop");
    const winner = renderToStaticMarkup(h(Avatar, { name: "Mia", color: "blue", winner: true }));
    expect(winner).toContain("outline-primary");
    const resigned = renderToStaticMarkup(h(Avatar, { name: "Tom", color: "yellow", resigned: true }));
    expect(resigned).toContain("opacity-40");
  });

  it("nennt Zustände im barrierefreien Namen", () => {
    const html = renderToStaticMarkup(
      h(Avatar, { name: "Mia", color: "blue", host: true, answered: true, label: "Mia" }),
    );
    expect(html).toContain('role="img" aria-label="Mia, Host, hat geantwortet"');
  });

  it("hält die Badges am Kreis, auch wenn Flex/Grid den Avatar strecken würde", () => {
    const html = renderToStaticMarkup(h(Avatar, { name: "Ben", color: "sky", answered: true, host: true }));
    // äußerer Wrapper = Bezugsrahmen der absolut positionierten Badges; size-fit verhindert stretch
    expect(html).toMatch(/^<span aria-hidden="true" class="[^"]*\bsize-fit\b/);
  });

  it("stürzt bei unbekannter Farbe nicht ab", () => {
    const html = renderToStaticMarkup(h(Avatar, { name: "X", color: "green" as "blue" }));
    expect(html).toContain("bg-player-blue");
  });
});

describe("PlayerRow", () => {
  it("zeigt Host, offline und für den Host den Entfernen-Button", () => {
    const html = renderToStaticMarkup(
      h(PlayerRow, { name: "Lea", color: "cyan", connected: false, isHost: true, onKick: () => {} }),
    );
    expect(html).toContain("lucide-crown");
    expect(html).toContain(">Host<");
    expect(html).toContain(">offline<");
    expect(html).toContain('aria-label="Lea entfernen"');
    expect(html).toContain("lucide-user-round-x");
  });

  it("zeigt ohne Handler keinen Entfernen-Button und streicht Aufgegebene durch", () => {
    const html = renderToStaticMarkup(h(PlayerRow, { name: "Tom", color: "yellow", resigned: true }));
    expect(html).not.toContain("lucide-user-round-x");
    expect(html).toContain("line-through");
    expect(html).toContain(">Aufgegeben<");
  });
});

describe("RankingList", () => {
  it("listet Platz, Name und Punkte; Aufgegebene mit Hinweis", () => {
    const html = renderToStaticMarkup(
      h(RankingList, {
        entries: [
          { playerId: "a", place: 1, name: "Mia", color: "blue", score: 12, status: "active" },
          { playerId: "b", place: 1, name: "Ben", color: "sky", score: 12, status: "active" },
          { playerId: "c", place: 3, name: "Lea", color: "cyan", score: 4, status: "resigned" },
        ],
      }),
    );
    expect(html.match(/<li /g)).toHaveLength(3);
    expect(html).toContain('<ol aria-label="Rangliste"');
    expect(html).toContain("tabular-nums");
    expect(html).toContain(">Aufgegeben<");
    expect(html).toContain("line-through");
  });
});

describe("Podium", () => {
  it("stellt 2-1-3 mit den Höhen 96/128/72 dar, im DOM Platz 1 zuerst", () => {
    const html = renderToStaticMarkup(
      h(Podium, {
        entries: [
          { playerId: "a", place: 1, name: "Mia", color: "blue", score: 12 },
          { playerId: "b", place: 2, name: "Ben", color: "sky", score: 10 },
          { playerId: "c", place: 3, name: "Lea", color: "cyan", score: 7 },
        ],
      }),
    );
    const orders = [...html.matchAll(/order-(\d)/g)].map((match) => match[1]);
    expect(orders).toEqual(["2", "1", "3"]);
    expect(html.indexOf("h-32")).toBeLessThan(html.indexOf("h-24"));
    expect(html.indexOf("h-24")).toBeLessThan(html.indexOf("h-18"));
    expect(html).toContain("Platz 1, ");
    expect(html).toContain("outline-primary");
  });

  it("stellt Gleichplatzierte auf gleich hohe Säulen (ADR-017: Gleichstand = gleicher Platz)", () => {
    const heights = (places: readonly number[]) => {
      const entries = places.map((place, index) => ({
        playerId: `p${index}`,
        place,
        name: `P${index}`,
        color: "blue" as const,
        score: 10 - place,
      }));
      const html = renderToStaticMarkup(h(Podium, { entries }));
      return [...html.matchAll(/\b(h-32|h-24|h-18)\b/g)].map((match) => match[1]);
    };
    expect(heights([1, 2, 3])).toEqual(["h-32", "h-24", "h-18"]);
    expect(heights([1, 2, 2])).toEqual(["h-32", "h-24", "h-24"]);
    expect(heights([1, 1, 3])).toEqual(["h-32", "h-32", "h-18"]);
    expect(heights([1, 1, 1])).toEqual(["h-32", "h-32", "h-32"]);
  });

  it("lässt Säulen nach Platz wachsen (3 → 2 → 1), Gleichplatzierte gemeinsam", () => {
    expect([3, 2, 1].map((place) => podiumGrowStep(place, [1, 2, 3]))).toEqual([0, 1, 2]);
    expect([2, 1].map((place) => podiumGrowStep(place, [1, 2, 2]))).toEqual([0, 1]);
    expect([3, 1].map((place) => podiumGrowStep(place, [1, 1, 3]))).toEqual([0, 1]);
    expect(podiumGrowStep(1, [1, 1, 1])).toBe(0);
  });
});

describe("ScorePill", () => {
  it("zeigt die Punkte tabular, 28 hoch, mit Screenreader-Text", () => {
    const html = renderToStaticMarkup(h(ScorePill, { score: 12 }));
    expect(html).toContain("h-7");
    expect(html).toContain("tabular-nums");
    expect(html).toContain(">12<");
    expect(html).toContain("12 Punkte");
  });
});
