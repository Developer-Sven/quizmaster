import { readFileSync } from "node:fs";
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

  /** Der sichtbare Teil der Antwort ohne Zustandsfarben: Buchstaben-Kästchen, Textspalte, Icon-Slot. */
  const LONG = "Die Schifffahrtsgesellschaft aus Hamburg";
  const STATES: readonly AnswerState[] = ["idle", "locked", "dimmed", "correct", "wrong", "disabled"];
  const anatomy = (state: AnswerState) => {
    const html = renderToStaticMarkup(h(AnswerButton, { index: 3, text: LONG, state }));
    const letterBox = /<span class="(flex size-7 shrink-0 [^"]*?) border-[a-z-]+ text-[a-z0-9-]+">D<\/span>/.exec(html);
    const textColumn = /<span class="([^"]*flex-1[^"]*)">Die Schifffahrtsgesellschaft aus Hamburg/.exec(html);
    const slot = /<span aria-hidden="true" data-slot="answer-icon" class="([^"]+)">(.*?)<\/span><\/button>$/.exec(html);
    return { html, letterBox: letterBox?.[1], textColumn: textColumn?.[1], slot: slot?.[1], icon: slot?.[2] ?? null };
  };

  it("hält rechts in allen Zuständen denselben Icon-Slot frei (20 × 20) – leer bei idle, dimmed und disabled", () => {
    const icons: Record<string, string | null> = {};
    for (const state of STATES) {
      const { slot, icon } = anatomy(state);
      expect(slot, state).toBe("flex size-5 shrink-0 items-center justify-center");
      icons[state] = icon === "" ? "" : (/lucide-([a-z-]+)/.exec(icon ?? "")?.[1] ?? icon);
    }
    expect(icons).toEqual({
      idle: "",
      locked: "lock",
      dimmed: "",
      correct: "circle-check",
      wrong: "circle-x",
      disabled: "",
    });
    expect(anatomy("locked").icon).toContain('width="16"');
    expect(anatomy("correct").icon).toContain('width="20"');
    expect(anatomy("wrong").icon).toContain('width="20"');
  });

  it("40-Zeichen-Antwort: in idle, locked, correct und wrong dieselbe Textbreite und damit dieselbe Zeilenzahl", () => {
    // Ohne Layout-Engine: Gleiche Zeilenzahl folgt aus gleicher Breite der Textspalte – Buchstaben-Kästchen,
    // Abstände, Innenabstand, Rahmen und Icon-Slot sind in allen Zuständen gleich; nur Farben wechseln. Gemessen
    // im Browser (E2E, screen-checks.ts → `answerLines`) gilt dasselbe für die Zeilenzahl selbst.
    expect(LONG).toHaveLength(40);
    const reference = anatomy("idle");
    expect(reference.letterBox).toBe(
      "flex size-7 shrink-0 items-center justify-center rounded-sm border text-label transition-control",
    );
    expect(reference.textColumn).toBe("min-w-0 flex-1 text-answer text-text hyphens-auto wrap-break-word");
    const outer = (html: string) =>
      (/^<button[^>]*class="([^"]+)"/.exec(html)?.[1] ?? "")
        .split(" ")
        .filter((token) => !/^(?:border-(?!2$)|bg-|opacity-|is-|motion-safe:)/.test(token));
    for (const state of ["locked", "correct", "wrong"] as const) {
      const other = anatomy(state);
      expect(other.letterBox, state).toBe(reference.letterBox);
      expect(other.textColumn, state).toBe(reference.textColumn);
      expect(other.slot, state).toBe(reference.slot);
      expect(outer(other.html), state).toEqual(outer(reference.html));
    }
  });

  it("trennt lange Wörter (hyphens-auto, Sprache de aus <html>) statt sie über den Rand ragen zu lassen", () => {
    expect(anatomy("idle").textColumn).toContain("hyphens-auto");
    expect(anatomy("idle").textColumn).toContain("wrap-break-word");
    const layout = readFileSync(new URL("../../app/layout.tsx", import.meta.url), "utf8");
    expect(layout).toMatch(/<html lang="de"/);
  });

  it("nimmt den sichtbaren Buchstaben in den zugänglichen Namen auf – vorn, wie sichtbar (WCAG 2.5.3)", () => {
    for (const state of STATES) {
      const html = render(state);
      const button = /^<button[^>]*>/.exec(html)?.[0] ?? "";
      expect(button, state).not.toContain("aria-label");
      // Name aus dem Inhalt: zuerst das Buchstaben-Kästchen (nicht versteckt), dann der Antworttext
      const letter = /<span class="flex size-7[^"]*"[^>]*>C<\/span>/.exec(html)?.[0] ?? "";
      expect(letter, state).not.toBe("");
      expect(letter, state).not.toContain("aria-hidden");
      expect(html.indexOf(">C</span>"), state).toBeLessThan(html.indexOf("Canberra"));
    }
    expect(render("correct")).toMatch(/>C<\/span><span class="[^"]*">Canberra<span class="sr-only">, richtig<\/span>/);
  });

  it("nimmt nicht bedienbare Antworten aus dem Tab-Pfad (bleiben fokussierbar, der Fokus springt nicht weg)", () => {
    expect(render("idle")).not.toContain("tabindex");
    expect(render("idle")).not.toContain("aria-disabled");
    for (const state of ["locked", "dimmed", "correct", "wrong", "disabled"] as const) {
      const button = /^<button[^>]*>/.exec(render(state))?.[0] ?? "";
      expect(button, state).toContain('tabindex="-1"');
      expect(button, state).toContain('aria-disabled="true"');
      // kein `disabled`-Attribut: das würde den Fokus der gerade eingeloggten Antwort auf <body> werfen
      expect(button, state).not.toMatch(/\sdisabled(=|\s|>)/);
    }
  });
});

describe("TimerBar und TimerRing", () => {
  it("läuft als CSS-Animation mit Restzeit-Variablen und role=timer", () => {
    const html = renderToStaticMarkup(h(TimerBar, { runId: "q1", remainingMs: 12_000, durationMs: 20_000 }));
    expect(html).toContain('role="timer"');
    expect(html).toContain("h-1.5");
    expect(html).toContain("animate-timer-bar");
    expect(html).toContain("--timer-remaining:12000ms;--timer-from:0.6;--timer-danger-delay:7000ms");
    expect(html).toContain('aria-live="polite"');
  });

  it("bleibt im Kontrastmodus (forced colors) sichtbar: Spur mit Rahmen, Balken in Textfarbe", () => {
    const html = renderToStaticMarkup(h(TimerBar, { runId: 1, remainingMs: 12_000, durationMs: 20_000 }));
    expect(html).toContain("forced-colors:outline");
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    const utility = /@utility animate-timer-bar \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(utility).toMatch(/@variant forced-colors \{[^}]*forced-color-adjust: none;[^}]*CanvasText/);
    // Die Farbe kommt aus dem Utility selbst: eine bg-Klasse stünde später im Stylesheet und gewönne
    expect(utility).toContain("background-color: var(--color-primary);");
    expect(/class="([^"]*animate-timer-bar[^"]*)"/.exec(html)?.[1]).not.toMatch(/\bbg-/);
  });

  it("braucht eine Lauf-Identität (runId) statt Restzeit/Dauer als Schlüssel", () => {
    // Ohne runId entschied `${remainingMs}/${durationMs}` über den Neustart: gleiche (geklemmte) Werte
    // zweier Fragen starteten nicht neu, jede andere Wertänderung setzte den Timer zurück.
    // @ts-expect-error runId ist Pflicht – tsc (pnpm typecheck) prüft das
    const bar = renderToStaticMarkup(h(TimerBar, { remainingMs: 12_000, durationMs: 20_000 }));
    // @ts-expect-error runId ist Pflicht – tsc (pnpm typecheck) prüft das
    const ring = renderToStaticMarkup(h(TimerRing, { remainingMs: 12_000, durationMs: 15_000 }));
    expect(bar).toContain('role="timer"');
    expect(ring).toContain('role="timer"');
    // runId landet nicht im DOM
    const html = renderToStaticMarkup(h(TimerBar, { runId: "r1-t2-q3", remainingMs: 12_000, durationMs: 20_000 }));
    expect(html).not.toContain("r1-t2-q3");
  });

  it("zeigt abgelaufen keinen Balken mehr", () => {
    const html = renderToStaticMarkup(h(TimerBar, { runId: "q1", remainingMs: 0, durationMs: 20_000 }));
    expect(html).not.toContain("animate-timer-bar");
    expect(html).not.toContain("aria-live");
  });

  it("zeigt im Ring die Sekunden tabular und wird abgelaufen rot", () => {
    const running = renderToStaticMarkup(h(TimerRing, { runId: "p1", remainingMs: 15_000, durationMs: 15_000 }));
    expect(running).toContain('role="timer"');
    expect(running).toContain("size-12");
    expect(running).toContain('pathLength="100"');
    expect(running).toContain("stroke-primary animate-timer-ring");
    expect(running).toMatch(/tabular-nums[^"]*">15</);
    const expired = renderToStaticMarkup(h(TimerRing, { runId: "p1", remainingMs: 0, durationMs: 15_000 }));
    expect(expired).toContain("text-danger");
    expect(expired).toMatch(/>0</);
    expect(expired).not.toContain("animate-timer-ring");
  });
});

describe("QuestionCard", () => {
  it("wechselt ab 101 Zeichen auf question-long und zeigt den TimerBar oben", () => {
    const short = renderToStaticMarkup(
      h(QuestionCard, { prompt: "Kurz?", timer: { runId: "q1", remainingMs: 20_000, durationMs: 20_000 } }),
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

  it("zeigt richtig/falsch zusätzlich per Glyphe, nicht nur per Farbe (docs/09 §12, WCAG 1.4.1)", () => {
    const render = (result: "correct" | "wrong" | "open" | "none", appearDelayMs?: number) =>
      renderToStaticMarkup(h(ResultSquare, { result, appearDelayMs }));
    expect(render("correct")).toContain("lucide-check");
    expect(render("wrong")).toContain("lucide-x");
    expect(render("open")).not.toContain("<svg");
    expect(render("none")).not.toContain("<svg");
    expect(render("correct", 80)).toContain("lucide-check");
    expect(render("wrong", 80)).toContain("lucide-x");
  });

  it("zeichnet im Kontrastmodus (forced colors) einen Rahmen statt nur einer Fläche", () => {
    for (const result of ["correct", "wrong", "open"] as const) {
      expect(renderToStaticMarkup(h(ResultSquare, { result })), result).toContain("border border-transparent");
    }
    expect(renderToStaticMarkup(h(ResultSquare, { result: "wrong", appearDelayMs: 0 }))).toContain(
      "border border-transparent",
    );
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

  it("nennt „aufgegeben“ im Spaltenkopf und dimmt die Kästchen Aufgegebener nicht", () => {
    const html = renderToStaticMarkup(
      h(Board, {
        players: [
          { id: "a", name: "Mia", color: "blue", score: 5 },
          { id: "b", name: "Tom", color: "yellow", score: 2, resigned: true },
        ],
        rows: [{ key: "r1", category: books, results: { a: [true], b: [false] } }],
        questionsPerTurn: 1,
      }),
    );
    expect(html).toContain("Mia, Summe");
    expect(html).toContain("Tom, aufgegeben, Summe");
    // nur der Avatar (docs/09 §5) ist gedimmt, nicht die Ergebnis-Kästchen (Kontrast ≥ 3:1)
    expect(html.match(/opacity-40/g)).toHaveLength(1);
  });

  it("bricht Kästchen nach 3 um, damit Spalten bei K bis 10 schmal bleiben", () => {
    const html = renderToStaticMarkup(
      h(Board, {
        players: [{ id: "a", name: "Mia", color: "blue", score: 5 }],
        rows: [{ key: "r1", category: books, results: { a: [true, true, false, true, false, true] } }],
        questionsPerTurn: 10,
      }),
    );
    expect(html.match(/role="img" aria-label="(richtig|falsch|offen)"/g)).toHaveLength(10);
    // Zeilen à höchstens 3 Kästchen (3 + 3 + 3 + 1): min-content bleibt 3 Kästchen breit, die Tabelle
    // quetscht die Spalten also nicht, sondern scrollt bei 6–8 Personen weiter horizontal
    expect(html.match(/<span class="flex gap-1">/g)).toHaveLength(4);
    expect(html).toContain('<td class="px-1 py-2">');
  });

  it("staffelt die Füllung neuer Zeilen", () => {
    expect(fillDelayMs(0, 0, 0)).toBe(0);
    expect(fillDelayMs(0, 1, 0)).toBe(40);
    expect(fillDelayMs(0, 0, 2)).toBe(320);
    expect(fillDelayMs(1, 2, 1)).toBe(280);
  });
});
