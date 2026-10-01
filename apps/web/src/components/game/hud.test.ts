/**
 * HUD (docs/09 §7, §10): Der Ton-Umschalter ist ein Schalter mit gleichbleibendem Namen „Ton“ – an/aus trägt
 * `aria-checked` (WCAG 4.1.2), sichtbar `volume-2`/`volume-x`. Serverseitig gerendert – geprüft wird das Markup.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hud, type HudProps } from "./hud";

const noop = () => {};

function soundButton(soundOn: boolean): string {
  const props: HudProps = {
    progress: "Runde 1/3 · Zug 1/2",
    announcement: null,
    canResign: true,
    soundOn,
    onToggleSound: noop,
    onResign: noop,
  };
  const html = renderToStaticMarkup(h(Hud, props));
  const button = /<button[^>]*data-testid="hud-sound"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0];
  if (!button) throw new Error("Ton-Umschalter fehlt");
  return button;
}

describe("HUD: Ton-Umschalter", () => {
  it("ist ein Schalter mit dem Namen „Ton“ – an: aria-checked=true und volume-2", () => {
    const on = soundButton(true);
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('aria-label="Ton"');
    expect(on).toContain("lucide-volume-2");
  });

  it("behält den Namen, wenn der Ton aus ist – nur der Zustand und das Icon wechseln", () => {
    const off = soundButton(false);
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('aria-label="Ton"');
    expect(off).toContain("lucide-volume-x");
  });

  it("vermischt keine zweite Zustandssemantik und färbt das Icon nicht orange", () => {
    for (const soundOn of [true, false]) {
      const button = soundButton(soundOn);
      expect(button).not.toContain("aria-pressed");
      expect(button).not.toContain("text-primary");
      expect(button).toContain('title="Ton"');
    }
  });
});
