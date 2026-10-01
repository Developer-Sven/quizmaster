/**
 * Toast-Abstand (docs/09 §5 „Toast: unten über der Aktionsleiste“): Am Spielende ist die Aktionsleiste bis zu
 * 201 px hoch (Revanche, „Fragen ansehen“, „Lobby verlassen“) – ein fester Abstand von 96 px legte den Toast über
 * ihre Buttons (Befund W3). Der Toast richtet sich deshalb nach der Höhe, die die Aktionsleiste als
 * `--sticky-bottom` meldet (components/app/sticky-inset.tsx).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const utility = /@utility bottom-toast \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
const bottom = (/bottom:\s*([\s\S]*?);/.exec(utility)?.[1] ?? "").replace(/\s+/g, " ").trim();

describe("Toast über der Aktionsleiste", () => {
  it("steht mindestens 96 px (+ Safe Area) über dem unteren Rand – wie bisher über Spielerstreifen und Lobby-Leiste", () => {
    expect(bottom.startsWith("max(")).toBe(true);
    expect(bottom).toContain("calc(var(--spacing) * 24 + env(safe-area-inset-bottom))");
  });

  it("steht 8 px über einer höheren Aktionsleiste (gemeldete Höhe --sticky-bottom, ohne Leiste 0)", () => {
    expect(bottom).toContain("calc(var(--sticky-bottom, 0px) + var(--spacing) * 2)");
  });

  it("bleibt bei offenem Sheet oder Dialog beim festen Abstand – die Aktionsleiste liegt dann verdeckt darunter", () => {
    const modal = /:root:has\(\[aria-modal="true"\]\) & \{\s*bottom:\s*([^;]+);\s*\}/.exec(utility)?.[1];
    expect(modal?.replace(/\s+/g, " ")).toBe("calc(var(--spacing) * 24 + env(safe-area-inset-bottom))");
  });

  it("wird vom Toast genutzt (fest unten, über allen Ebenen außer dem Verbindungs-Overlay)", () => {
    const toast = readFileSync(new URL("../components/ui/toast.tsx", import.meta.url), "utf8");
    expect(toast).toMatch(/className="[^"]*fixed inset-x-0 bottom-toast z-toast/);
  });
});
