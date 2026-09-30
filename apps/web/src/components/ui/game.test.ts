import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { squareResult } from "../../lib/ui/results";
import { AnswerButton, type AnswerState } from "./answer-button";
import { Board, fillDelayMs } from "./board";
import { CategoryBadge } from "./category-badge";
import { CategoryIcon } from "./category-icon";
import { CategoryTile } from "./category-tile";
import { QuestionCard } from "./question-card";
import { ResultSquare } from "./result-square";
import { TimerBar } from "./timer-bar";
import { TimerRing } from "./timer-ring";

const books = { name: "Bücher & Wörter", icon: "book-open", color: "#EBB447" };

describe("CategoryIcon", () => {
  it("setzt die Kategoriefarbe als --cat und zeichnet das Icon in text-cat", () => {
    const html = renderToStaticMarkup(h(CategoryIcon, { icon: "book-open", color: "#EBB447", frame: "tile" }));
    expect(html).toContain('style="--cat:#EBB447"');
    expect(html).toContain("size-12");
    expect(html).toContain("rounded-md border border-line bg-bg text-cat");
    expect(html).toContain("lucide-book-open");
  });

  it("zeigt bei unbekanntem Icon nichts und verwirft ungültige Farben", () => {
    expect(renderToStaticMarkup(h(CategoryIcon, { icon: "rocket", color: "#EBB447" }))).toBe("");
    const tile = renderToStaticMarkup(h(CategoryIcon, { icon: "rocket", color: "red; x:y", frame: "tile" }));
    expect(tile).not.toContain("<svg");
    expect(tile).not.toContain("style=");
  });

  it("füllt nur die Reveal-Kachel in Kategoriefarbe", () => {
    const html = renderToStaticMarkup(h(CategoryIcon, { icon: "globe", color: "#3F9FF3", frame: "reveal" }));
    expect(html).toContain("size-24");
    expect(html).toContain("bg-cat text-bg");
    expect(html).toContain('width="48"');
  });
});

describe("CategoryTile und CategoryBadge", () => {
  it("ist 88 hoch, bedienbar und zeigt die Auswahl mit 2 px primary", () => {
    const html = renderToStaticMarkup(h(CategoryTile, { category: books, selected: true, onSelect: () => {} }));
    expect(html).toMatch(/^<button[^>]*aria-pressed="true"/);
    expect(html).toContain("h-22");
    expect(html).toContain("border-2");
    expect(html).toContain("border-primary");
    expect(html).toContain("text-title");
  });

  it("ist für Zuschauende nicht bedienbar", () => {
    const html = renderToStaticMarkup(h(CategoryTile, { category: books, viewOnly: true, highlighted: true }));
    expect(html).toMatch(/^<div/);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("is-hover");
    expect(html).toContain("border-primary");
  });

  it("zeigt kompakt nur das Icon mit Namen für Screenreader", () => {
    const html = renderToStaticMarkup(h(CategoryBadge, { category: books, compact: true }));
    expect(html).toContain('role="img" aria-label="Bücher &amp; Wörter"');
    expect(html).toContain("size-8");
    expect(renderToStaticMarkup(h(CategoryBadge, { category: books }))).toContain("h-8");
  });
});

describe("AnswerButton", () => {
  const render = (state: AnswerState, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(h(AnswerButton, { index: 2, text: "Canberra", state, ...extra }));

  it("zeigt Buchstabe, Mindesthöhe 64 und 2 px Rahmen; nur idle ist bedienbar", () => {
    const idle = render("idle");
    expect(idle).toContain(">C<");
    expect(idle).toContain("min-h-16");
    expect(idle).toContain("border-2 ");
    expect(idle).toContain('aria-keyshortcuts="3 C"');
    expect(idle).not.toContain("aria-disabled");
    expect(render("locked")).toContain('aria-disabled="true"');
  });

  it("zeigt eingeloggt, richtig und falsch zusätzlich per Icon und Screenreader-Text", () => {
    const locked = render("locked");
    expect(locked).toContain("border-primary bg-primary-tint");
    expect(locked).toContain("lucide-lock");
    expect(locked).toContain(", eingeloggt");
    const correct = render("correct");
    expect(correct).toContain("border-success bg-success-tint");
    expect(correct).toContain("lucide-circle-check");
    expect(correct).toContain(", richtig");
    const wrong = render("wrong", { shake: true });
    expect(wrong).toContain("border-danger bg-danger-tint");
    expect(wrong).toContain("lucide-circle-x");
    expect(wrong).toContain(", falsch");
    expect(wrong).toContain("motion-safe:animate-shake");
  });

  it("dimmt übrige Antworten und ruckelt nur bei falsch", () => {
    expect(render("dimmed")).toContain("opacity-50");
    expect(render("correct", { shake: true })).not.toContain("animate-shake");
  });

  it("zeigt höchstens 4 Avatare und dann „+N“", () => {
    const pickers = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, name: `P${id}`, color: "blue" as const }));
    const html = render("correct", { pickedBy: pickers });
    expect(html.match(/bg-player-blue/g)).toHaveLength(4);
    expect(html).toContain(">+2<");
    expect(html).toContain("gewählt von Pa, Pb, Pc, Pd, Pe, Pf");
  });
});

describe("TimerBar und TimerRing", () => {
  it("läuft als CSS-Animation mit Restzeit-Variablen und role=timer", () => {
    const html = renderToStaticMarkup(h(TimerBar, { remainingMs: 12_000, durationMs: 20_000 }));
    expect(html).toContain('role="timer"');
    expect(html).toContain("h-1.5");
    expect(html).toContain("animate-timer-bar");
    expect(html).toContain("--timer-remaining:12000ms;--timer-from:0.6;--timer-danger-delay:7000ms");
    expect(html).toContain('aria-live="polite"');
  });

  it("zeigt abgelaufen keinen Balken mehr", () => {
    const html = renderToStaticMarkup(h(TimerBar, { remainingMs: 0, durationMs: 20_000 }));
    expect(html).not.toContain("animate-timer-bar");
    expect(html).not.toContain("aria-live");
  });

  it("zeigt im Ring die Sekunden tabular und wird abgelaufen rot", () => {
    const running = renderToStaticMarkup(h(TimerRing, { remainingMs: 15_000, durationMs: 15_000 }));
    expect(running).toContain('role="timer"');
    expect(running).toContain("size-12");
    expect(running).toContain('pathLength="100"');
    expect(running).toContain("stroke-primary animate-timer-ring");
    expect(running).toMatch(/tabular-nums[^"]*">15</);
    const expired = renderToStaticMarkup(h(TimerRing, { remainingMs: 0, durationMs: 15_000 }));
    expect(expired).toContain("text-danger");
    expect(expired).toMatch(/>0</);
    expect(expired).not.toContain("animate-timer-ring");
  });
});

describe("QuestionCard", () => {
  it("wechselt ab 101 Zeichen auf question-long und zeigt den TimerBar oben", () => {
    const short = renderToStaticMarkup(
      h(QuestionCard, { prompt: "Kurz?", timer: { remainingMs: 20_000, durationMs: 20_000 } }),
    );
    expect(short).toContain("text-question ");
    expect(short).toContain('role="timer"');
    expect(short).toContain("rounded-xl border border-line bg-surface-1 p-5");
    const long = renderToStaticMarkup(h(QuestionCard, { prompt: "x".repeat(101) }));
    expect(long).toContain("text-question-long");
    expect(long).not.toContain('role="timer"');
  });

  it("zeigt Flaggen nur mit gültigem Code", () => {
    const flag = renderToStaticMarkup(
      h(QuestionCard, { prompt: "Welches Land?", media: { kind: "flag", code: "de" } }),
    );
    expect(flag).toContain('src="/flags/de.svg"');
    expect(flag).toContain('alt="Flagge"');
    expect(flag).toContain("h-30 w-40");
    const evil = renderToStaticMarkup(
      h(QuestionCard, { prompt: "Welches Land?", media: { kind: "flag", code: "../../x" } }),
    );
    expect(evil).not.toContain("<img");
  });
});

describe("ResultSquare und Board", () => {
  it("hat vier Zustände mit Screenreader-Text", () => {
    const render = (result: "correct" | "wrong" | "open" | "none") => renderToStaticMarkup(h(ResultSquare, { result }));
    expect(render("correct")).toContain('aria-label="richtig"');
    expect(render("correct")).toContain("bg-success");
    expect(render("wrong")).toContain("bg-danger");
    expect(render("open")).toContain("bg-line");
    expect(render("none")).toContain("border-2 border-danger bg-danger-tint");
    expect(render("none")).toContain("size-3.5 shrink-0 rounded-sm");
  });

  it("übersetzt Tafelwerte", () => {
    expect([true, false, null, undefined].map(squareResult)).toEqual(["correct", "wrong", "none", "open"]);
  });

  it("zeigt Kopf mit Avataren und Summe, Züge mit kompakten Badges und K Kästchen je Person", () => {
    const html = renderToStaticMarkup(
      h(Board, {
        players: [
          { id: "a", name: "Mia", color: "blue", score: 5, rankChange: "up" },
          { id: "b", name: "Ben", color: "sky", score: 3, rankChange: "down" },
        ],
        rows: [{ key: "r1", category: books, results: { a: [true, false], b: [null] } }],
        questionsPerTurn: 3,
      }),
    );
    expect(html).toContain("<caption");
    expect(html.match(/<th scope="col"/g)).toHaveLength(3);
    expect(html).toContain('<th scope="row" class="sticky left-0');
    expect(html.match(/role="img" aria-label="(richtig|falsch|offen|keine Antwort)"/g)).toHaveLength(6);
    expect(html).toContain('aria-label="Platz verbessert"');
    expect(html).toContain('aria-label="Platz verschlechtert"');
    expect(html).toContain("overflow-x-auto");
  });

  it("staffelt die Füllung neuer Zeilen", () => {
    expect(fillDelayMs(0, 0, 0)).toBe(0);
    expect(fillDelayMs(0, 1, 0)).toBe(40);
    expect(fillDelayMs(0, 0, 2)).toBe(160);
    expect(fillDelayMs(1, 2, 1)).toBe(200);
  });
});
