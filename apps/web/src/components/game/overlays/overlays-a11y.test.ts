/**
 * Struktur der Spiel-Overlays für Screenreader und niedrige Viewports (WCAG 1.3.1, 1.3.2, 2.4.6, 4.1.2, 1.4.10):
 * serverseitig gerendert (wie overlay-frame.test.ts) – geprüft wird das Markup, nicht die Bewegung.
 */
import type { BoardRow, PublicPlayer, PublicQuestion } from "@quizmaster/shared";
import { type ComponentType, createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MotionProvider } from "../../../lib/ui/motion";
import { AnswerRevealOverlay } from "./answer-reveal-overlay";
import { GameOverOverlay } from "./game-over-overlay";
import { OverlayFrame } from "./overlay-frame";
import { type OverlayLayout, OverlayLayoutContext } from "./overlay-layout";
import { QuestionOverlay } from "./question-overlay";
import { RoundBoardOverlay } from "./round-board-overlay";

const noop = () => {};
const NOW = Date.now();

function render<P extends object>(component: ComponentType<P>, props: P, layout: OverlayLayout = "stage"): string {
  const content: ReactNode = h(MotionProvider, null, h(component as ComponentType<P>, props));
  return renderToStaticMarkup(h(OverlayLayoutContext, { value: layout }, content));
}

function player(id: string, name: string, score: number, color: PublicPlayer["color"]): PublicPlayer {
  return { id, name, color, isHost: id === "p1", isBot: false, connected: true, status: "active", score };
}

const mia = player("p1", "Mia", 2, "blue");
const ben = player("p2", "Ben", 1, "sky");

const PROMPT = "Wie heißt die Hauptstadt von Australien?";

const question: PublicQuestion = {
  id: "q2x7k2m9p4",
  index: 2,
  total: 3,
  categoryId: "buecher-woerter",
  prompt: PROMPT,
  answers: ["Sydney", "Canberra", "Melbourne", "Perth"],
  media: null,
  startsAt: NOW - 2_000,
  deadline: NOW + 18_000,
  answeredBy: [],
};

/** Text des Elements mit dieser ID (einfaches Markup ohne verschachtelte Tags). */
function textById(html: string, id: string): string | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`id="${escaped}"[^>]*>([^<]*)<`).exec(html)?.[1] ?? null;
}

describe("Frage: Antwortgruppe trägt die Frage als Namen (1.3.1, 4.1.2)", () => {
  const html = render(QuestionOverlay, {
    question,
    myChoice: null,
    canAnswer: true,
    waitingCount: 1,
    runId: "q2:0",
    onAnswer: noop,
  });

  it("benennt die Gruppe mit dem Fragetext und beschreibt sie mit „Frage 2 von 3“", () => {
    const group = /<fieldset[^>]*>/.exec(html)?.[0] ?? "";
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(group)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(group)?.[1];
    expect(group).not.toContain("aria-label=");
    expect(labelledBy && textById(html, labelledBy)).toBe(PROMPT);
    expect(describedBy && textById(html, describedBy)).toBe("Frage 2 von 3");
  });

  it("hat eine Überschrift für die Frage und den Wartehinweis direkt unter der Karte (docs/09 §7.5)", () => {
    expect(html).toMatch(/<h2[^>]*>Frage 2 von 3<\/h2>/);
    const prompt = html.indexOf(`>${PROMPT}</p>`);
    const waiting = html.indexOf('data-testid="question-waiting"');
    const firstAnswer = html.indexOf('data-testid="answer-0"');
    expect(prompt).toBeGreaterThan(-1);
    expect(waiting).toBeGreaterThan(prompt);
    expect(waiting).toBeLessThan(firstAnswer);
  });
});

describe("Auflösung: gleiche Gruppe, gleiche Lage", () => {
  const reveal: PublicQuestion = { ...question, correct: 1, picks: { p1: 2, p2: 1 } };

  it("fasst die Antworten in einer Gruppe mit dem Fragetext als Namen zusammen", () => {
    const html = render(AnswerRevealOverlay, {
      question: reveal,
      players: [mia, ben],
      selfId: "p1",
      phaseStartedAt: NOW - 500,
      phaseEndsAt: NOW + 4_500,
    });
    const group = /<fieldset[^>]*>/.exec(html)?.[0] ?? "";
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(group)?.[1];
    expect(labelledBy && textById(html, labelledBy)).toBe(PROMPT);
    expect(html).toMatch(/<h2[^>]*>Frage 2 von 3<\/h2>/);
  });
});

describe("Rundentafel im Duell: Tabelle mit Personen-Spalten (1.3.1, 1.3.2)", () => {
  const board: BoardRow[] = [
    {
      round: 1,
      pickerId: "p2",
      categoryId: "buecher-woerter",
      results: { p1: [true, true, false], p2: [false, true, null] },
    },
    {
      round: 1,
      pickerId: "p1",
      categoryId: "musik-hits",
      results: { p1: [true, false, false], p2: [true, true, true] },
    },
  ];
  const categories = {
    "buecher-woerter": { id: "buecher-woerter", name: "Bücher & Wörter", icon: "book-open", color: "#EBB447" },
    "musik-hits": { id: "musik-hits", name: "Musik & Hits", icon: "music", color: "#5988F8" },
  };
  const html = render(RoundBoardOverlay, {
    board,
    participants: [mia, ben],
    round: 1,
    rounds: 3,
    categories,
    questionsPerTurn: 3,
    selfId: "p1",
    phaseStartedAt: NOW - 1_000,
  });

  it("ist eine Tabelle: Spaltenköpfe mit Namen, Zeilenköpfe mit der Kategorie – in Lesereihenfolge links | Kategorie | rechts", () => {
    expect(html).toContain("<table");
    const heads = [...html.matchAll(/<th[^>]*scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((match) => match[1] ?? "");
    expect(heads).toHaveLength(3);
    expect(heads[0]).toContain("Mia");
    expect(heads[2]).toContain("Ben");
    const rowHeads = [...html.matchAll(/<th[^>]*scope="row"/g)];
    expect(rowHeads).toHaveLength(2);
    const firstRow = /<tbody>[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    const left = firstRow.indexOf("<td");
    const category = firstRow.indexOf('scope="row"');
    const right = firstRow.lastIndexOf("<td");
    expect(left).toBeLessThan(category);
    expect(category).toBeLessThan(right);
    expect(html).not.toMatch(/\border-[123]\b/);
  });

  it("nennt den Spielstand mit Namen", () => {
    expect(html).toContain("Mia: 3 Punkte, Ben: 4 Punkte");
  });
});

describe("Spielende: Ergebnis als Überschrift, Duell-Stand mit Namen (1.3.1, 2.4.6)", () => {
  const results = {
    outcome: "win" as const,
    ranking: [
      { playerId: "p1", place: 1, score: 7, status: "active" as const },
      { playerId: "p2", place: 2, score: 5, status: "active" as const },
    ],
  };
  const html = render(GameOverOverlay, {
    results,
    participants: [mia, ben],
    board: [],
    categories: {},
    questionsPerTurn: 3,
    selfId: "p1",
    phaseStartedAt: NOW - 3_000,
    onShowRules: () => undefined,
  });

  it("zeigt die Ergebnis-Headline als Überschrift, die den Fokus übernehmen kann", () => {
    expect(html).toMatch(/<h2[^>]*data-testid="game-over-headline"[^>]*>Gewonnen<\/h2>/);
    expect(html).toMatch(/<h2[^>]*tabindex="-1"/);
  });

  it("sagt den Duell-Stand mit Namen an", () => {
    expect(html).toContain("Mia: 7 Punkte, Ben: 5 Punkte");
  });

  it("öffnet die Regeln als Sheet – nie per Seitenwechsel oder neuem Tab (ADR-052)", () => {
    expect(html).toMatch(/<button type="button" aria-haspopup="dialog" data-testid="rules-link"/);
    expect(html).not.toContain('href="/regeln"');
  });
});

describe("OverlayFrame bei niedrigem Viewport (1.4.10)", () => {
  it("steht im Fluss und wächst mit dem Inhalt statt absolut auf einer starren Bühne zu liegen", () => {
    const flow = render(OverlayFrame, { testId: "overlay-question", children: "Frage" }, "flow");
    const section = /<section[^>]*>/.exec(flow)?.[0] ?? "";
    expect(section).toMatch(/class="[^"]*\brelative\b/);
    expect(section).not.toMatch(/\babsolute\b/);
    expect(section).not.toMatch(/overflow-y-auto/);

    const stage = render(OverlayFrame, { testId: "overlay-question", children: "Frage" }, "stage");
    expect(/<section[^>]*>/.exec(stage)?.[0]).toMatch(/absolute inset-0 overflow-y-auto/);
  });
});
