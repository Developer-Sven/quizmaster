import { PresenceContext } from "motion/react";
import { type ComponentProps, type ComponentType, createElement as h, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MotionProvider } from "../../../lib/ui/motion";
import { OVERLAY_EXIT_FALLBACK_MS, OverlayFrame } from "./overlay-frame";

type PresenceValue = NonNullable<ComponentProps<typeof PresenceContext.Provider>["value"]>;

const noop = () => {};

/** createElement mit Kindern als Argument (wie `renderHtml` in components/ui/ssr-render.ts). */
function el<P extends object>(
  component: ComponentType<P>,
  props: Omit<P, "children">,
  ...children: ReactNode[]
): ReactElement {
  return h(component as ComponentType<Omit<P, "children">>, props, ...children);
}

/**
 * Rendert den Rahmen ohne AnimatePresence (`null`) oder mit einem Präsenz-Kontext wie in `AnimatePresence`
 * (`custom` = Übergang der Bühne, siehe `stageTransition`).
 */
function render(
  isPresent: boolean | null,
  options: { custom?: "fade" | "cut"; leaving?: boolean; initial?: false; sheet?: boolean } = {},
): string {
  const frame = el(
    MotionProvider,
    {},
    el(OverlayFrame, { testId: "overlay-question", leaving: options.leaving, sheet: options.sheet }, "Frage"),
  );
  if (isPresent === null) return renderToStaticMarkup(frame);
  const presence: PresenceValue = {
    id: "p",
    initial: options.initial,
    isPresent,
    custom: options.custom,
    onExitComplete: noop,
    register: () => noop,
  };
  return renderToStaticMarkup(h(PresenceContext.Provider, { value: presence }, frame));
}

describe("OverlayFrame", () => {
  it("ist ohne AnimatePresence und solange präsent bedienbar (kein inert, kein data-exiting)", () => {
    for (const html of [render(null), render(true)]) {
      expect(html).toContain('data-testid="overlay-question"');
      expect(html).not.toContain("data-exiting");
      expect(html).not.toContain("inert");
    }
  });

  it("markiert ausblendende Overlays als inert und data-exiting (keine Klicks, kein Vorlesen, E2E-Filter)", () => {
    const html = render(false);
    expect(html).toContain('data-exiting="true"');
    expect(html).toMatch(/\sinert(=""|\s|>)/);
  });

  it("blendet beim Übergang „fade“ ein (opacity 0, y 12), beim Übergang „cut“ steht der Inhalt sofort", () => {
    expect(render(true, { custom: "fade" })).toMatch(/opacity:0/);
    expect(render(true, { custom: "cut" })).not.toMatch(/opacity:0/);
  });

  it("ist beim „cut“ hinaus im selben Commit unsichtbar (nie zwei Karten übereinander)", () => {
    const html = render(false, { custom: "cut" });
    expect(html).toContain('data-exiting="true"');
    expect(html).toMatch(/class="[^"]*\binvisible\b/);
    expect(render(false, { custom: "fade" })).not.toMatch(/class="[^"]*\binvisible\b/);
  });

  it("blendet innerhalb der Phase aus (Intro, Kategorie, Auflösung): inert und data-exiting", () => {
    const html = render(true, { leaving: true });
    expect(html).toContain('data-exiting="true"');
    expect(html).toMatch(/\sinert(=""|\s|>)/);
  });

  it("verankert ein Sheet unten ohne Seiten-/unteren Innenabstand und ohne eigene Einblendung (docs/09 §7.7)", () => {
    const sheet = render(true, { custom: "fade", sheet: true });
    const column = /<section[^>]*><div class="([^"]+)"/.exec(sheet)?.[1] ?? "";
    expect(column.split(" ")).toEqual(
      expect.arrayContaining(["mx-auto", "flex", "w-full", "max-w-column", "flex-col", "justify-end", "pt-4"]),
    );
    expect(column).not.toMatch(/\b(?:px-gutter|py-4|pb-|justify-center)\b/);
    // Das Sheet fährt selbst hoch – der Rahmen blendet nicht zusätzlich ein (kein opacity 0, kein y 12)
    expect(sheet).not.toMatch(/opacity:0/);
    expect(sheet).not.toMatch(/translateY\(12px\)/);
    const normal = /<section[^>]*><div class="([^"]+)"/.exec(render(true, { custom: "fade" }))?.[1] ?? "";
    expect(normal).toContain("px-gutter py-4");
  });

  it("gibt die Bühne spätestens kurz nach dem Ausblenden (200 ms) frei", () => {
    expect(OVERLAY_EXIT_FALLBACK_MS).toBeGreaterThan(200);
    expect(OVERLAY_EXIT_FALLBACK_MS).toBeLessThanOrEqual(600);
  });
});
