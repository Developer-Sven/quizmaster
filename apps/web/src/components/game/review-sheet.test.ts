/**
 * „Fragen ansehen“ (docs/09 §6): Nach dem Melden zeigt die Zeile `flag` in `text-3` (bereits gemeldet) – nicht
 * die 40 % Deckkraft eines deaktivierten IconButton. Serverseitig gerendert – geprüft wird das Markup.
 */
import type { PublicPlayer, ReviewItem } from "@quizmaster/shared";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewRow } from "./review-sheet";

const noop = () => {};

const players: PublicPlayer[] = [
  { id: "p1", name: "Mia", color: "blue", isHost: true, isBot: false, connected: true, status: "active", score: 1 },
];

const item = (myReported: boolean): ReviewItem => ({
  questionId: "q1x7k2m9p4",
  categoryId: "buecher-woerter",
  prompt: "Wie heißt die Hauptstadt von Australien?",
  media: null,
  answers: ["Sydney", "Canberra", "Melbourne", "Perth"],
  correct: 1,
  explanation: null,
  picks: { p1: 0 },
  myRating: null,
  myReported,
});

function reportButton(myReported: boolean): string {
  const html = renderToStaticMarkup(
    h(ReviewRow, { item: item(myReported), players, categories: {}, selfId: "p1", onRate: noop, onStartReport: noop }),
  );
  const button = /<button[^>]*data-testid="review-report"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0];
  if (!button) throw new Error("Melden-Button fehlt");
  return button;
}

describe("Fragen ansehen: Melden", () => {
  it("bietet ungemeldet „Frage melden“ als bedienbaren IconButton (flag in text)", () => {
    const button = reportButton(false);
    expect(button).toContain('aria-label="Frage melden"');
    expect(button).not.toMatch(/\saria-disabled="/);
    expect(button).toContain("text-text");
    expect(button).toContain("lucide-flag");
  });

  it("zeigt gemeldet flag in text-3, voll deckend – gesperrt, aber weiter als „Bereits gemeldet“ auffindbar", () => {
    const button = reportButton(true);
    expect(button).toContain('aria-label="Bereits gemeldet"');
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain("text-text-3");
    expect(button).not.toMatch(/opacity-/);
    expect(button).toContain("size-11");
    expect(button).toMatch(/<svg[^>]*width="24"[^>]*class="lucide lucide-flag/);
  });
});
