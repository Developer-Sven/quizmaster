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

/** Rendert den Rahmen ohne AnimatePresence (`null`) oder mit einem Präsenz-Kontext wie in `AnimatePresence`. */
function render(isPresent: boolean | null): string {
  const frame = el(MotionProvider, {}, el(OverlayFrame, { testId: "overlay-question" }, "Frage"));
  if (isPresent === null) return renderToStaticMarkup(frame);
  const presence: PresenceValue = {
    id: "p",
    initial: false,
    isPresent,
    custom: undefined,
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

  it("gibt die Bühne spätestens kurz nach dem Ausblenden (200 ms) frei", () => {
    expect(OVERLAY_EXIT_FALLBACK_MS).toBeGreaterThan(200);
    expect(OVERLAY_EXIT_FALLBACK_MS).toBeLessThanOrEqual(600);
  });
});
